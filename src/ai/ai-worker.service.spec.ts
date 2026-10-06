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
  memory: {
    idleMinutes: 120,
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
    carriedContext: null,
  },
  verdict: null,
  notes: [],
};

const claimedRow = (
  id = 'job-1',
  conversationMessageId = 'assistant-1',
  attempts = 0,
  kind = 'REPLY',
) => ({
  id,
  conversationMessageId,
  kind,
  attempts,
  input: jobInput,
});

const summaryJobInput = {
  studentId: 'student-1',
  conversationId: 'conv-1',
};

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
    aiGenerationJob: { create: ReturnType<typeof vi.fn> };
  };
  let aiService: {
    generateAndApply: ReturnType<typeof vi.fn>;
    summarizeConversation: ReturnType<typeof vi.fn>;
  };
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
      aiGenerationJob: { create: vi.fn().mockResolvedValue({ id: 'job-9' }) },
    };
    aiService = {
      generateAndApply: vi.fn(),
      summarizeConversation: vi.fn().mockResolvedValue({
        summaryId: 'sum-1',
        notes: [],
        embedded: true,
      }),
    };
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
      .mockResolvedValueOnce([]) // idle scan (nothing stale)
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
    expect(aiService.summarizeConversation).not.toHaveBeenCalled();
    const successUpdate = prisma.$executeRaw.mock.calls.at(-1)?.[0] as unknown as string[];
    expect((successUpdate as string[] | undefined)?.join('')).toContain("'SUCCEEDED'");
    expect(auditService.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_generation.exhausted' }),
    );
  });

  it('reschedules PENDING with the first delay (DB-side NOW + interval)', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // idle scan
      .mockResolvedValueOnce([{ id: 'job-1' }]) // due
      .mockResolvedValueOnce([claimedRow('job-1', 'assistant-1', 0)]) // claim
      .mockResolvedValue([{ status: 'PENDING' }]); // reschedule outcome
    aiService.generateAndApply.mockRejectedValue(
      new AiGenerationError('provider down'),
    );

    await worker.scanOnce();

    const rescheduleCall = prisma.$queryRaw.mock.calls[3] as unknown as unknown[];
    expect(rescheduleCall).toBeDefined();
    // The SET clause is compose-side (nested Prisma.Sql passed as a value).
    const nested = rescheduleCall![1] as { sql: string };
    expect(String(nested?.sql ?? nested)).toContain("status = 'PENDING'");
    expect(String(nested?.sql ?? nested)).toContain("NOW() + (interval '1 second' *");
    expect(prisma.conversationMessage.update).not.toHaveBeenCalled();
  });

  it('marks the job FAILED once retries are exhausted', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // idle scan
      .mockResolvedValueOnce([{ id: 'job-3' }]) // due (job exists in PENDING)
      .mockResolvedValueOnce([claimedRow('job-3', 'assistant-3', 3)]) // claim: attempts=3 (past the schedule)
      .mockResolvedValue([{ status: 'FAILED' }]); // terminal FAILED move
    aiService.generateAndApply.mockRejectedValue(
      new AiGenerationError('still down'),
    );

    await worker.scanOnce();

    // attempts(3) + 1 = 4 > 3 delays → terminal branch
    const terminalCall = prisma.$queryRaw.mock.calls[3] as unknown as unknown[];
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
    prisma.$queryRaw.mockResolvedValue([]); // idle + due scans empty
    prisma.$executeRaw.mockResolvedValue(2); // reclaim count

    await worker.scanOnce();

    const reclaimCall = prisma.$executeRaw.mock.calls[0][0] as unknown as string[];
    const sql = reclaimCall.join('');
    expect(sql).toContain("SET status = 'PENDING'");
    expect(sql).toContain("NOW() - (interval '1 second'");
  });

  it('skips a job another runner claimed first', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // idle scan
      .mockResolvedValueOnce([{ id: 'job-1' }]) // due
      .mockResolvedValue([]); // claim lost
    aiService.generateAndApply = vi.fn();

    await worker.scanOnce();

    expect(aiService.generateAndApply).not.toHaveBeenCalled();
  });

  it('closes idle ACTIVE conversations and queues a SUMMARY job', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'conv-1', studentId: 'student-1' },
      ]) // idle scan finds one
      .mockResolvedValue([]); // due scan empty
    prisma.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1); // reclaim, then close
    prisma.aiGenerationJob.create.mockClear();

    await worker.scanOnce();

    const closeCall = prisma.$executeRaw.mock.calls[1][0] as unknown as string[];
    expect(closeCall.join('')).toContain("SET status = 'CLOSED'");
    expect(prisma.aiGenerationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'SUMMARY',
          conversationMessageId: null,
          input: summaryJobInput,
        }),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.closed' }),
    );
  });

  it('runs SUMMARY jobs through summarizeConversation and completes them', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // idle scan
      .mockResolvedValueOnce([{ id: 'job-sum' }]) // due
      .mockResolvedValueOnce([
        {
          id: 'job-sum',
          conversationMessageId: null,
          kind: 'SUMMARY',
          attempts: 0,
          input: summaryJobInput,
        },
      ]) // claim
      .mockResolvedValue([{ status: 'SUCCEEDED' }]);

    await worker.scanOnce();

    expect(aiService.summarizeConversation).toHaveBeenCalledWith(summaryJobInput);
    expect(aiService.generateAndApply).not.toHaveBeenCalled();
    expect(prisma.conversationMessage.update).not.toHaveBeenCalled();
    const successUpdate = prisma.$executeRaw.mock.calls.at(-1)?.[0] as unknown as string[];
    expect((successUpdate as string[] | undefined)?.join('')).toContain("'SUCCEEDED'");
  });

  it('reschedules a failing SUMMARY job and audits SessionSummary exhaustion', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // idle scan
      .mockResolvedValueOnce([{ id: 'job-sum' }]) // due
      .mockResolvedValueOnce([
        {
          id: 'job-sum',
          conversationMessageId: null,
          kind: 'SUMMARY',
          attempts: 3,
          input: summaryJobInput,
        },
      ]) // claim
      .mockResolvedValue([{ status: 'FAILED' }]); // terminal move
    aiService.summarizeConversation.mockRejectedValue(
      new AiGenerationError('summary model down'),
    );

    await worker.scanOnce();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai_generation.exhausted',
        entity: 'SessionSummary',
      }),
    );
  });
});
