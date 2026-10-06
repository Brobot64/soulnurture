import { Test, TestingModule } from '@nestjs/testing';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import { AiGenerationError } from './ai.errors.js';
import { AiService } from './ai.service.js';
import type { AiOrchestrationInput } from './ai.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiWorkerService } from './ai-worker.service.js';

const aiConfigStub = {
  async: {
    pollMs: 5_000,
    staleClaimMs: 120_000,
    retryDelaysMs: [5_000, 30_000, 120_000],
    holdingMessage: 'holds',
  },
} as unknown as AiConfig;

const jobInput: AiOrchestrationInput = {
  studentId: 'student-1',
  conversationId: 'conv-1',
  checkInId: null,
  userContent: 'rough day',
  language: 'en',
  studentRef: 'Jude O.',
  classLabel: null,
};

const orchestratedOutcome = {
  result: {
    message: 'Real AI reply',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
    exerciseLabel: null,
    asyncState: 'COMPLETE',
  },
  context: {
    student: { firstName: 'Jude', preferredLanguage: 'en' },
    currentCheckIn: null,
    recentConversation: [],
    relevantReflection: null,
    relevantResources: [],
    currentJourneyStep: null,
  },
  verdict: null,
  notes: [],
};

const claimedRow = (id = 'job-1', conversationMessageId = 'assistant-1', attempts = 0) => ({
  id,
  conversationMessageId,
  attempts,
  input: jobInput,
});

describe('AiWorkerService', () => {
  let worker: AiWorkerService;
  let prisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
    conversation: { update: ReturnType<typeof vi.fn> };
    conversationMessage: {
      update: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let aiService: { generateAndApply: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(0),
      conversation: { update: vi.fn().mockResolvedValue({}) },
      conversationMessage: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ aiPayload: {} }),
      },
    };
    aiService = { generateAndApply: vi.fn() };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiWorkerService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiService, useValue: aiService },
        { provide: AuditService, useValue: auditService },
        { provide: AI_CONFIG, useValue: aiConfigStub },
      ],
    }).compile();
    worker = module.get(AiWorkerService);
  });

  it('claims due PENDING jobs atomically, rewrites the placeholder message and completes the job', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'job-1' }]) // due scan
      .mockResolvedValueOnce([claimedRow()]) // claim
      .mockResolvedValue([{ status: 'SUCCEEDED' }]); // terminal update
    aiService.generateAndApply.mockResolvedValue(orchestratedOutcome);

    await worker.scanOnce();

    expect(prisma.conversationMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'assistant-1' },
        data: expect.objectContaining({ content: 'Real AI reply' }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv-1' } }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const successUpdate = prisma.$executeRaw.mock.calls.at(-1)?.[0] as unknown as string[];
    expect((successUpdate as string[] | undefined)?.join('')).toContain("'SUCCEEDED'");
    expect(auditService.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_generation.exhausted' }),
    );
  });

  it('reschedules PENDING with the first delay (DB-side NOW + interval)', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'job-1' }]) // due
      .mockResolvedValueOnce([claimedRow('job-1', 'assistant-1', 0)]) // claim
      .mockResolvedValue([{ status: 'PENDING' }]); // reschedule outcome
    aiService.generateAndApply.mockRejectedValue(
      new AiGenerationError('provider down'),
    );

    try {
      await worker.scanOnce();
    } catch (e) {
      console.log('SCAN THREW:', e);
    }

    const rescheduleCall = prisma.$queryRaw.mock.calls[2] as unknown as unknown[];
    expect(rescheduleCall).toBeDefined();
    // The SET clause is compose-side (nested Prisma.Sql passed as a value).
    const nested = rescheduleCall![1] as { sql: string };
    expect(String(nested?.sql ?? nested)).toContain("status = 'PENDING'");
    expect(String(nested?.sql ?? nested)).toContain("NOW() + (interval '1 second' *");
    expect(prisma.conversationMessage.update).not.toHaveBeenCalled();
  });

  it('marks the job FAILED once retries are exhausted', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'job-3' }]) // due (job exists in PENDING)
      .mockResolvedValueOnce([claimedRow('job-3', 'assistant-3', 3)]) // claim: attempts=3 (past the schedule)
      .mockResolvedValue([{ status: 'FAILED' }]); // terminal FAILED move
    aiService.generateAndApply.mockRejectedValue(
      new AiGenerationError('still down'),
    );

    await worker.scanOnce();

    // attempts(3) + 1 = 4 > 3 delays → terminal branch
    const terminalCall = prisma.$queryRaw.mock.calls[2] as unknown as unknown[];
    const nestedTerminal = terminalCall![1] as { sql: string };
    expect(String(nestedTerminal?.sql ?? nestedTerminal)).toContain("status = 'FAILED'");
    expect(prisma.conversationMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'assistant-3' },
        data: expect.objectContaining({
          aiPayload: expect.objectContaining({ asyncState: 'FAILED' }),
        }),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_generation.exhausted' }),
    );
  });

  it('reclaims stale PROCESSING jobs back to PENDING via the DB clock', async () => {
    prisma.$queryRaw.mockResolvedValue([]); // due scan empty
    prisma.$executeRaw.mockResolvedValue(2); // reclaim count

    await worker.scanOnce();

    const reclaimCall = prisma.$executeRaw.mock.calls[0][0] as unknown as string[];
    const sql = reclaimCall.join('');
    expect(sql).toContain("SET status = 'PENDING'");
    expect(sql).toContain("NOW() - (interval '1 second'");
  });

  it('skips a job another runner claimed first', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'job-1' }]) // due
      .mockResolvedValue([]); // claim lost
    aiService.generateAndApply = vi.fn();

    await worker.scanOnce();

    expect(aiService.generateAndApply).not.toHaveBeenCalled();
  });
});
