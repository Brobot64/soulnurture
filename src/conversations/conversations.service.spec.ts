import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MessageRole } from '@prisma/client';
import { AiService } from '../ai/ai.service.js';
import { AiGenerationError } from '../ai/ai.errors.js';
import { AI_CONFIG } from '../ai/config/ai.config.js';
import type { AiConfig } from '../ai/config/ai.config.js';
import { IntentEngineService } from '../ai/intents/intent-engine.service.js';
import { LanguageDetectorService } from '../ai/language/language-detector.service.js';
import {
  GuardrailService,
  RateLimitExceededException,
} from '../ai/guardrails/guardrail.service.js';
import { AI_DISCLOSURE_CONSENT_VERSION } from '../ai/disclosure/ai-disclosure.js';
import { AuditService } from '../audit/audit.service.js';
import { ConsentRequiredException } from '../consent/consent.errors.js';
import { ConsentService } from '../consent/consent.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ConversationsService } from './conversations.service.js';

const HOLDING_MESSAGE =
  'Thank you for sharing that with me — I am still thinking about it and will be right here.';

const aiConfigStub = {
  promptVersion: 'v3',
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
  guided: {
    maxBaseTurns: 3,
    maxExtendedTurns: 5,
    extension: 'TELL_MORE',
    directives: {
      TELL_MORE: 'DIRECTIVE_TELL_MORE',
      SHOW_IDEA: 'DIRECTIVE_SHOW_IDEA',
      TALK_TO_SOMEONE: 'DIRECTIVE_TALK_TO_SOMEONE',
    },
    wrapUpDirective: 'DIRECTIVE_WRAP_UP',
    flagDirective: 'DIRECTIVE_FLAG',
  },
  language: {
    offerEnabled: true,
    supported: ['en', 'pcm', 'yo', 'ha', 'ig'],
    vernacularReplyMode: 'openai-native',
    natlasBaseUrl: null,
    natlasModel: 'n-atlas',
    understandingMaxOutputTokens: 120,
    understandingTimeoutMs: 15_000,
  },
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
  let studentsService: { ensureProfile: ReturnType<typeof vi.fn> };
  let consentService: {
    hasAcceptedForStudent: ReturnType<typeof vi.fn>;
  };

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
    studentsService = {
      ensureProfile: vi.fn().mockResolvedValue(student),
    };
    consentService = {
      hasAcceptedForStudent: vi.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StudentsService, useValue: studentsService },
        { provide: AiService, useValue: ai },
        IntentEngineService,
        LanguageDetectorService,
        { provide: GuardrailService, useValue: guardrail },
        { provide: AuditService, useValue: auditService },
        { provide: ConsentService, useValue: consentService },
        { provide: AI_CONFIG, useValue: aiConfigStub },
      ],
    }).compile();

    service = module.get(ConversationsService);
  });

  it('rate gate rejects before any write or AI call when the limit is exceeded', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      status: 'ACTIVE',
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
      status: 'ACTIVE',
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
    expect(result.recommendedActivity).toBeNull();
    expect(result.activeIntent).toBeNull();
    expect(result.aiPending).toBe(false);
    expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
  });

  it('surfaces the recommended activity alongside the resource', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      status: 'ACTIVE',
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
      ...orchestratedOutcome,
      result: {
        ...orchestratedOutcome.result,
        activity: {
          recommended: true,
          slug: 'box-breathing',
          title: 'Box Breathing (4-4-4-4)',
        },
      },
    });

    const result = await service.sendMessage('user-1', 'conv-1', {
      content: 'I feel overwhelmed',
    });

    expect(result.recommendedActivity).toEqual({
      slug: 'box-breathing',
      title: 'Box Breathing (4-4-4-4)',
    });
    expect(result.recommendedResource).not.toBeNull();
  });

  it('surfaces the active intent when the engine made a verdict', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      studentId: student.id,
      checkInId: null,
      status: 'ACTIVE',
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
      status: 'ACTIVE',
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
      status: 'ACTIVE',
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

  describe('consent gate', () => {
    const openConversation = () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        checkInId: null,
        status: 'ACTIVE',
        messages: [],
      });
    };

    it('blocks conversation creation when the disclosure is not accepted', async () => {
      consentService.hasAcceptedForStudent.mockResolvedValue(false);

      await expect(
        service.create('user-1', { source: 'chat' }),
      ).rejects.toThrow(ConsentRequiredException);

      expect(consentService.hasAcceptedForStudent).toHaveBeenCalledWith(
        student.id,
        AI_DISCLOSURE_CONSENT_VERSION,
      );
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('blocks a message before the rate gate and before any write', async () => {
      openConversation();
      consentService.hasAcceptedForStudent.mockResolvedValue(false);

      const error = await service
        .sendMessage('user-1', 'conv-1', { content: 'hi' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConsentRequiredException);
      expect((error as ConsentRequiredException).getStatus()).toBe(403);
      expect(guardrail.assertMessageAllowed).not.toHaveBeenCalled();
      expect(prisma.conversationMessage.create).not.toHaveBeenCalled();
      expect(ai.generateAndApply).not.toHaveBeenCalled();
      expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
    });

    it('lets an accepted disclosure through to the AI turn', async () => {
      openConversation();
      prisma.conversationMessage.create.mockResolvedValue({
        id: 'msg-1',
        role: MessageRole.ASSISTANT,
        content: 'I hear you.',
      });
      prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
      ai.generateAndApply.mockResolvedValue(orchestratedOutcome);

      const result = await service.sendMessage('user-1', 'conv-1', {
        content: 'I feel overwhelmed',
      });

      expect(consentService.hasAcceptedForStudent).toHaveBeenCalledWith(
        student.id,
        AI_DISCLOSURE_CONSENT_VERSION,
      );
      expect(result.assistantMessage.content).toBe('I hear you.');
    });
  });

  describe('guided replies', () => {
    function mockActiveConversation(messages: unknown[] = []) {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        checkInId: null,
        status: 'ACTIVE',
        messages,
      });
      prisma.conversationMessage.create.mockImplementation(async (args: {
        data: { role: MessageRole; content: string; quickReply?: string | null };
      }) => ({
        id: `msg-${Math.random().toString(16).slice(2)}`,
        role: args.data.role,
        content: args.data.content,
        quickReply: args.data.quickReply ?? null,
      }));
      prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
      ai.generateAndApply.mockResolvedValue(orchestratedOutcome);
    }

    it('rejects sends on a closed conversation with 409 before any write', async () => {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        checkInId: null,
        status: 'CLOSED',
        messages: [],
      });

      await expect(
        service.sendMessage('user-1', 'conv-1', { content: 'hi' }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.conversationMessage.create).not.toHaveBeenCalled();
      expect(guardrail.assertMessageAllowed).not.toHaveBeenCalled();
      expect(ai.generateAndApply).not.toHaveBeenCalled();
    });

    it('persists the quickReply marker and grants the TELL_MORE extension', async () => {
      mockActiveConversation();

      const result = await service.sendMessage('user-1', 'conv-1', {
        content: 'Tell me more',
        quickReply: 'TELL_MORE',
      });

      expect(result.userMessage.quickReply).toBe('TELL_MORE');
      expect(prisma.conversationMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ quickReply: 'TELL_MORE' }),
        }),
      );
      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          quickReply: 'TELL_MORE',
          freeTextTurns: 0,
          turnBudget: 5,
          finalTurn: false,
        }),
      );
    });

    it('counts free-text turns against the base budget and flags the final turn', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: null },
        { id: 'm2', role: MessageRole.ASSISTANT, quickReply: null },
        { id: 'm3', role: MessageRole.USER, quickReply: null },
      ]);

      await service.sendMessage('user-1', 'conv-1', { content: 'third turn' });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          quickReply: null,
          freeTextTurns: 3,
          turnBudget: 3,
          finalTurn: true,
        }),
      );
    });

    it('extends the free-text budget to 5 once any TELL_MORE exists in the conversation', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: null },
        { id: 'm2', role: MessageRole.USER, quickReply: 'TELL_MORE' },
        { id: 'm3', role: MessageRole.USER, quickReply: null },
      ]);

      await service.sendMessage('user-1', 'conv-1', {
        content: 'third free turn',
      });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          freeTextTurns: 3,
          turnBudget: 5,
          finalTurn: false,
        }),
      );
    });

    it('wraps at 5 total turns even when the free-text budget was extended', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: null },
        { id: 'm2', role: MessageRole.USER, quickReply: 'TELL_MORE' },
        { id: 'm3', role: MessageRole.USER, quickReply: null },
        { id: 'm4', role: MessageRole.USER, quickReply: null },
      ]);

      await service.sendMessage('user-1', 'conv-1', {
        content: 'fourth free turn',
      });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          freeTextTurns: 4,
          turnBudget: 5,
          finalTurn: true,
        }),
      );
    });

    it('quick-reply taps skip the free-text budget but count toward the total cap', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: null },
        { id: 'm2', role: MessageRole.USER, quickReply: null },
      ]);

      await service.sendMessage('user-1', 'conv-1', {
        content: 'Show me an idea',
        quickReply: 'SHOW_IDEA',
      });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          quickReply: 'SHOW_IDEA',
          freeTextTurns: 2,
          turnBudget: 3,
          finalTurn: false,
        }),
      );
    });

    it('a fifth-turn tap wraps the conversation up', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: null },
        { id: 'm2', role: MessageRole.USER, quickReply: 'TELL_MORE' },
        { id: 'm3', role: MessageRole.USER, quickReply: null },
        { id: 'm4', role: MessageRole.USER, quickReply: null },
      ]);

      await service.sendMessage('user-1', 'conv-1', {
        content: 'Show me an idea',
        quickReply: 'SHOW_IDEA',
      });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          quickReply: 'SHOW_IDEA',
          freeTextTurns: 3,
          turnBudget: 5,
          finalTurn: true,
        }),
      );
    });

    it('a tap-only conversation still wraps at 5 total turns', async () => {
      mockActiveConversation([
        { id: 'm1', role: MessageRole.USER, quickReply: 'SHOW_IDEA' },
        { id: 'm2', role: MessageRole.USER, quickReply: 'SHOW_IDEA' },
        { id: 'm3', role: MessageRole.USER, quickReply: 'SHOW_IDEA' },
        { id: 'm4', role: MessageRole.USER, quickReply: 'TELL_MORE' },
      ]);

      await service.sendMessage('user-1', 'conv-1', {
        content: 'Tell you more',
        quickReply: 'TELL_MORE',
      });

      const sent = ai.generateAndApply.mock.calls[0][0];
      expect(sent).toEqual(
        expect.objectContaining({
          quickReply: 'TELL_MORE',
          freeTextTurns: 0,
          turnBudget: 5,
          finalTurn: true,
        }),
      );
    });
  });

  describe('language layer', () => {
    function mockHappyPath(userMessageId: string, assistantMessageId: string) {
      prisma.conversation.findUnique.mockResolvedValue({
        id: 'conv-1',
        studentId: student.id,
        checkInId: null,
        status: 'ACTIVE',
        messages: [],
      });
      prisma.conversationMessage.create
        .mockImplementationOnce(
          async (args: { data: Record<string, unknown> }) => ({
            ...args.data,
            id: userMessageId,
          }),
        )
        .mockImplementationOnce(
          async (args: { data: Record<string, unknown> }) => ({
            ...args.data,
            id: assistantMessageId,
          }),
        );
      prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });
      ai.generateAndApply.mockResolvedValue(orchestratedOutcome);
    }

    it('detects Yoruba, offers the language switch and queues a VERNACULAR job', async () => {
      mockHappyPath('user-msg-1', 'assistant-msg-1');

      const result = await service.sendMessage('user-1', 'conv-1', {
        content: 'Mo ti rẹ̀ rẹ̀ lónìí',
      });

      expect(result.languageOffer).toEqual({ detected: 'yo', current: 'en' });
      expect(prisma.aiGenerationJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'VERNACULAR',
          conversationMessageId: 'user-msg-1',
          input: expect.objectContaining({
            studentId: student.id,
            conversationId: 'conv-1',
            language: 'yo',
            firstPassFlagged: false,
          }),
        }),
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ai_understanding.queued',
          entity: 'ConversationMessage',
          entityId: 'user-msg-1',
          meta: expect.objectContaining({
            conversationId: 'conv-1',
            language: 'yo',
            detectedBy: 'diacritics',
            confidence: 'high',
            firstPassFlagged: false,
          }),
        }),
      );
    });

    it('leaves English content without an offer or a VERNACULAR job', async () => {
      mockHappyPath('user-msg-2', 'assistant-msg-2');

      const result = await service.sendMessage('user-1', 'conv-1', {
        content: 'I feel overwhelmed today because of my exams.',
      });

      expect(result.languageOffer).toBeNull();
      expect(prisma.aiGenerationJob.create).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ai_understanding.queued' }),
      );
    });

    it('queues understanding without an offer when the preference is not English', async () => {
      studentsService.ensureProfile.mockResolvedValue({
        ...student,
        preferredLanguage: 'yo',
      });
      mockHappyPath('user-msg-3', 'assistant-msg-3');

      const result = await service.sendMessage('user-1', 'conv-1', {
        content: 'Ina jin ɓacin rai sosai',
      });

      expect(result.languageOffer).toBeNull();
      expect(prisma.aiGenerationJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'VERNACULAR',
          conversationMessageId: 'user-msg-3',
          input: expect.objectContaining({ language: 'ha' }),
        }),
      });
    });
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
