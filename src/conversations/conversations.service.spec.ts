import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MessageRole } from '@prisma/client';
import { AiService } from '../ai/ai.service.js';
import { AiGenerationError } from '../ai/ai.errors.js';
import { AI_CONFIG } from '../ai/config/ai.config.js';
import type { AiConfig } from '../ai/config/ai.config.js';
import { IntentEngineService } from '../ai/intents/intent-engine.service.js';
import {
  GuardrailService,
  RateLimitExceededException,
} from '../ai/guardrails/guardrail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ConversationsService } from './conversations.service.js';

const HOLDING_MESSAGE =
  'Thank you for sharing that with me — I am still thinking about it and will be right here.';

const aiConfigStub = {
  promptVersion: 'v2',
  chat: { model: 'm', maxOutputTokens: 1000, temperature: 0.2, attemptTimeoutMs: 20_000 },
  transcription: { model: 't' },
  context: { messageLimit: 12, characterLimit: 12_000 },
  async: {
    pollMs: 5_000,
    staleClaimMs: 120_000,
    retryDelaysMs: [5_000, 30_000, 120_000],
    holdingMessage: HOLDING_MESSAGE,
  },
  safeguarding: { persistModelCandidates: true },
} as AiConfig;

describe('ConversationsService', () => {
  let service: ConversationsService;
  let prisma: {
    conversation: Record<string, ReturnType<typeof vi.fn>>;
    conversationMessage: Record<string, ReturnType<typeof vi.fn>>;
    aiGenerationJob: Record<string, ReturnType<typeof vi.fn>>;
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };
  let ai: { generateAndApply: ReturnType<typeof vi.fn> };
  let guardrail: { assertMessageAllowed: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    displayName: 'Amina O.',
    classLabel: 'S 300L',
    preferredLanguage: 'en',
  };

  const orchestratedOutcome = {
    result: {
      message: 'I hear you.',
      emotion: { detected: 'overwhelmed', confidence: 0.8 },
      reflection: { question: 'What supports you?', insight: null },
      resource: { recommended: true, resourceId: 'res-1' },
      humanSupport: {
        recommended: true,
        type: 'PROFESSIONAL',
        reason: 'Support available',
      },
      supportFlag: { candidate: false, category: null, severity: null },
      action: 'REFLECTION',
      exerciseLabel: null,
      asyncState: 'COMPLETE',
      usage: { latencyMs: 120 },
    },
    context: {
      student: { firstName: 'Amina', preferredLanguage: 'en' },
      currentCheckIn: null,
      recentConversation: [],
      relevantReflection: null,
      relevantResources: [
        { id: 'res-1', title: 'Breath', type: 'SOMATIC_EXERCISE', category: 'GROUNDING', description: 'Breathing guide' },
      ],
      currentJourneyStep: 2,
    },
    verdict: null,
    notes: [],
  };

  beforeEach(async () => {
    prisma = {
      conversation: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      conversationMessage: {
        create: vi.fn(),
        findMany: vi.fn(),
      },
      aiGenerationJob: { create: vi.fn() },
      supportFlag: { findFirst: vi.fn(), create: vi.fn() },
      sessionSummary: { findUnique: vi.fn() },
    };
    ai = { generateAndApply: vi.fn() };
    guardrail = { assertMessageAllowed: vi.fn() };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: {
            ensureProfile: vi.fn().mockResolvedValue(student),
          },
        },
        { provide: AiService, useValue: ai },
        IntentEngineService,
        { provide: GuardrailService, useValue: guardrail },
        { provide: AuditService, useValue: auditService },
        { provide: AI_CONFIG, useValue: aiConfigStub },
      ],
    }).compile();

    service = module.get(ConversationsService);
  });

  it('rate gate rejects before any write or AI call when the limit is exceeded', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      messages: [],
    });
    guardrail.assertMessageAllowed.mockImplementation(() => {
      throw new RateLimitExceededException('limit reached', 42);
    });

    await expect(
      service.sendMessage('user-1', 'conv-1', { content: 'hi' }),
    ).rejects.toThrow(RateLimitExceededException);

    expect(guardrail.assertMessageAllowed).toHaveBeenCalledWith(student.id);
    expect(prisma.conversationMessage.create).not.toHaveBeenCalled();
    expect(ai.generateAndApply).not.toHaveBeenCalled();
    expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
  });

  it('rejects access to another students conversation', async () => {
    const otherStudent = { ...student, id: 'student-2' };
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: otherStudent.id,
      messages: [],
    });

    await expect(
      service.sendMessage('user-1', 'conv-1', { content: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when conversation does not exist', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null);
    await expect(
      service.sendMessage('user-1', 'missing', { content: 'hi' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('creates user + assistant messages and returns the orchestrated AI result', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      messages: [],
    });
    prisma.conversationMessage.create.mockImplementation(async (args: {
      data: {
        conversationId: string;
        role: MessageRole;
        content: string;
        aiPayload?: unknown;
        activeExerciseLabel?: string | null;
      };
    }) => ({
      id: `msg-${Math.random().toString(16).slice(2)}`,
      conversationId: args.data.conversationId,
      role: args.data.role,
      content: args.data.content,
      aiPayload: args.data.aiPayload,
      activeExerciseLabel: args.data.activeExerciseLabel ?? null,
    }));
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
    ai.generateAndApply.mockResolvedValue(orchestratedOutcome);

    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'I feel overwhelmed',
    });

    expect(result.userMessage.role).toBe(MessageRole.USER);
    expect(result.assistantMessage.role).toBe(MessageRole.ASSISTANT);
    expect(result.assistantMessage.content).toBe('I hear you.');
    expect(result.humanCareRecommendation).toEqual(
      expect.objectContaining({ show: true }),
    );
    expect(result.recommendedResource).toEqual({
      id: 'res-1',
      title: 'Breath',
      type: null,
    });
    expect(result.activeIntent).toBeNull();
    expect(result.aiPending).toBe(false);
    expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
  });

  it('surfaces the active intent when the engine made a verdict', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      messages: [],
    });
    prisma.conversationMessage.create.mockImplementation(async (args: {
      data: { role: MessageRole; content: string };
    }) => ({
      id: 'assistant-1',
      role: args.data.role,
      content: args.data.content,
    }));
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
    ai.generateAndApply.mockResolvedValue({
      ...structuredClone(orchestratedOutcome),
      verdict: {
        intentId: 'SUICIDAL_IDEATION',
        intentLabel: 'Possible suicidal intent',
        severity: 'TIER_3_ACUTE',
        matchedBy: 'SERVER_KEYWORDS',
      },
    });

    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'there is no reason to live',
    });

    expect(result.activeIntent).toEqual(
      expect.objectContaining({ id: 'SUICIDAL_IDEATION', severity: 'TIER_3_ACUTE' }),
    );
    expect(result.aiPending).toBe(false);
  });

  it('AI failure lane: instant holding reply + queued regeneration job', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      messages: [],
    });
    prisma.conversationMessage.create.mockImplementation(async (args: {
      data: { role: MessageRole; content: string };
    }) => ({
      id: 'assistant-1',
      role: args.data.role,
      content: args.data.content,
    }));
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
    ai.generateAndApply.mockRejectedValue(
      new AiGenerationError('AI generation unavailable'),
    );

    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'I feel overwhelmed today',
    });

    expect(result.assistantMessage.content).toBe(HOLDING_MESSAGE);
    expect(result.aiPending).toBe(true);
    expect(prisma.aiGenerationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationMessageId: 'assistant-1',
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.supportFlag.create).not.toHaveBeenCalled();
  });

  it('AI failure lane still persists safeguarding state for crisis wording', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      messages: [],
    });
    prisma.conversationMessage.create.mockImplementation(async (args: {
      data: { role: MessageRole; content: string };
    }) => ({
      id: 'assistant-2',
      role: args.data.role,
      content: args.data.content,
    }));
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    prisma.supportFlag.create.mockResolvedValue({ id: 'flag-1' });
    ai.generateAndApply.mockRejectedValue(
      new AiGenerationError('AI generation unavailable'),
    );

    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'there is no reason to live',
    });

    expect(result.aiPending).toBe(true);
    expect(prisma.supportFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          intentId: 'SUICIDAL_IDEATION',
          severity: 'TIER_3_ACUTE',
          source: 'SERVER_POLICY',
        }),
      }),
    );
    expect(result.humanCareRecommendation).toEqual(
      expect.objectContaining({ show: true }),
    );
    expect(result.assistantMessage.content).toContain('connect');
  });

  describe('close', () => {
    it('closes an ACTIVE conversation and queues a SUMMARY job for the worker', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        status: 'ACTIVE',
        messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
      });
      prisma.conversation.update.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        status: 'CLOSED',
      });
      prisma.sessionSummary.findUnique.mockResolvedValue(null);
      prisma.aiGenerationJob.create.mockResolvedValue({ id: 'job-1' });

      const result = await service.close('user-1', 'conv-1');

      expect(result.summaryQueued).toBe(true);
      expect(result.conversation.status).toBe('CLOSED');
      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { status: 'CLOSED' },
      });
      expect(prisma.aiGenerationJob.create).toHaveBeenCalledWith({
        data: {
          kind: 'SUMMARY',
          conversationMessageId: null,
          input: { studentId: student.id, conversationId: 'conv-1' },
        },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          action: 'conversation.closed',
          entity: 'Conversation',
          entityId: 'conv-1',
          meta: { summaryQueued: true },
        }),
      );
    });

    it('is idempotent: an already CLOSED conversation queues nothing', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        status: 'CLOSED',
        messages: [{ id: 'msg-1' }],
      });

      const result = await service.close('user-1', 'conv-1');

      expect(result.summaryQueued).toBe(false);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.sessionSummary.findUnique).not.toHaveBeenCalled();
      expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('queues nothing for a conversation without messages', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        status: 'ACTIVE',
        messages: [],
      });
      prisma.conversation.update.mockResolvedValue({
        id: 'conv-1',
        status: 'CLOSED',
      });
      prisma.sessionSummary.findUnique.mockResolvedValue(null);

      const result = await service.close('user-1', 'conv-1');

      expect(result.summaryQueued).toBe(false);
      expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'conversation.closed',
          meta: { summaryQueued: false },
        }),
      );
    });

    it('queues nothing when a summary already exists', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        status: 'ACTIVE',
        messages: [{ id: 'msg-1' }],
      });
      prisma.conversation.update.mockResolvedValue({
        id: 'conv-1',
        status: 'CLOSED',
      });
      prisma.sessionSummary.findUnique.mockResolvedValue({ id: 'sum-1' });

      const result = await service.close('user-1', 'conv-1');

      expect(result.summaryQueued).toBe(false);
      expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
    });
  });
});
