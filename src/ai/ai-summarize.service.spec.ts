import { Test } from '@nestjs/testing';
import { AiService } from './ai.service.js';
import { AiGenerationError } from './ai.errors.js';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import { AiContextService } from './context/ai-context.service.js';
import { GuardrailService } from './guardrails/guardrail.service.js';
import { IntentEngineService } from './intents/intent-engine.service.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { SUMMARY_JSON_SCHEMA } from './memory/session-summary.schema.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_PROVIDER } from './providers/ai-provider.interface.js';
import { NatlasTranslationProvider } from './providers/natlas/natlas.provider.js';
import { NAtlasAsrProvider } from './providers/natlas/natlas-asr.provider.js';

const aiConfigStub = {
  context: { messageLimit: 12, characterLimit: 12_000 },
} as unknown as AiConfig;

const validSummary = {
  summary: 'The student shared about exam stress. They left feeling calmer.',
  topics: ['exam'],
  followUpHook: 'Check in about how the exam went.',
  emotionalTrend: 'CALMER',
};

describe('AiService.summarizeConversation', () => {
  let prisma: {
    conversation: { findFirst: ReturnType<typeof vi.fn> };
    conversationMessage: { findMany: ReturnType<typeof vi.fn> };
    sessionSummary: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };
  let memory: {
    embedAndStore: ReturnType<typeof vi.fn>;
    recall: ReturnType<typeof vi.fn>;
  };
  let generateResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    prisma = {
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conv-1' }) },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([
          { role: 'USER', content: 'I am stressed about my exam.' },
          { role: 'ASSISTANT', content: 'That sounds heavy. What would help?' },
        ]),
      },
      sessionSummary: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ ...validSummary, id: 'sum-1' }),
      },
    };
    memory = {
      embedAndStore: vi.fn().mockResolvedValue(true),
      recall: vi.fn(),
    };
    generateResponse = vi.fn().mockResolvedValue(validSummary);
  });

  async function createService() {
    const module = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: AI_PROVIDER,
          useValue: { generateResponse, transcribeAudio: vi.fn() },
        },
        { provide: AiContextService, useValue: { build: vi.fn() } },
        { provide: IntentEngineService, useValue: { evaluate: vi.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: vi.fn() } },
        { provide: GuardrailService, useValue: {} },
        { provide: MemoryRepository, useValue: memory },
        { provide: AI_CONFIG, useValue: aiConfigStub },
        {
          provide: NatlasTranslationProvider,
          useValue: { understand: vi.fn() },
        },
        { provide: NAtlasAsrProvider, useValue: { transcribeAudio: vi.fn() } },
      ],
    }).compile();
    return module.get(AiService);
  }

  it('validates, guards, persists and embeds a session summary', async () => {
    const service = await createService();

    const result = await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(result).toEqual({ summaryId: 'sum-1', notes: [], embedded: true });

    const sent = generateResponse.mock.calls[0][0] as {
      systemPrompt: string;
      messages: unknown[];
      jsonSchema: unknown;
    };
    expect(sent.systemPrompt).toContain('Transcript:');
    expect(sent.systemPrompt).toContain(
      'Student: I am stressed about my exam.',
    );
    expect(sent.systemPrompt).toContain('Canonical topics:');
    expect(sent.messages).toEqual([]);
    expect(sent.jsonSchema).toBe(SUMMARY_JSON_SCHEMA);

    expect(prisma.sessionSummary.create).toHaveBeenCalledWith({
      data: {
        studentId: 's1',
        conversationId: 'conv-1',
        summary: validSummary.summary,
        topics: ['exam'],
        followUpHook: validSummary.followUpHook,
        emotionalTrend: 'CALMER',
      },
    });
    expect(memory.embedAndStore).toHaveBeenCalledWith(
      'sum-1',
      `${validSummary.summary} exam`,
    );
  });

  it('short-circuits when the conversation already has a summary', async () => {
    prisma.sessionSummary.findUnique.mockResolvedValue({ id: 'sum-existing' });
    const service = await createService();

    const result = await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(result).toEqual({
      summaryId: 'sum-existing',
      notes: [],
      embedded: false,
    });
    expect(generateResponse).not.toHaveBeenCalled();
    expect(prisma.sessionSummary.create).not.toHaveBeenCalled();
  });

  it('throws when the conversation does not belong to the student', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    const service = await createService();

    await expect(
      service.summarizeConversation({
        studentId: 's1',
        conversationId: 'conv-1',
      }),
    ).rejects.toThrow(AiGenerationError);
    expect(prisma.sessionSummary.create).not.toHaveBeenCalled();
  });

  it('throws AiGenerationError when model output fails schema validation', async () => {
    generateResponse.mockResolvedValue({ nope: true });
    const service = await createService();

    await expect(
      service.summarizeConversation({
        studentId: 's1',
        conversationId: 'conv-1',
      }),
    ).rejects.toThrow(AiGenerationError);
    expect(prisma.sessionSummary.create).not.toHaveBeenCalled();
  });

  it('drops low-sensitivity-violating sentences before persisting', async () => {
    generateResponse.mockResolvedValue({
      ...validSummary,
      summary:
        'The student shared about exams. The student has clinical depression.',
    });
    prisma.sessionSummary.create.mockResolvedValue({
      id: 'sum-1',
      summary: 'The student shared about exams.',
      topics: ['exam'],
      followUpHook: validSummary.followUpHook,
      emotionalTrend: 'CALMER',
    });
    const service = await createService();

    const result = await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(prisma.sessionSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: 'The student shared about exams.',
        }),
      }),
    );
    expect(result.notes.join(' ')).toContain('diagnosis');
  });

  it('uses fallback copy when the guard drops every summary sentence', async () => {
    generateResponse.mockResolvedValue({
      ...validSummary,
      summary: 'The student has clinical depression.',
    });
    prisma.sessionSummary.create.mockResolvedValue({
      id: 'sum-1',
      summary: 'The student talked with Soul Nurture about their wellbeing.',
      topics: ['exam'],
      followUpHook: validSummary.followUpHook,
      emotionalTrend: 'CALMER',
    });
    const service = await createService();

    const result = await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(prisma.sessionSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: 'The student talked with Soul Nurture about their wellbeing.',
        }),
      }),
    );
    expect(result.notes.join(' ')).toContain('fallback copy used');
  });

  it('drops a follow-up hook that trips the guard', async () => {
    generateResponse.mockResolvedValue({
      ...validSummary,
      followUpHook: "Don't tell anyone we talked about this.",
    });
    prisma.sessionSummary.create.mockResolvedValue({
      id: 'sum-1',
      summary: validSummary.summary,
      topics: ['exam'],
      followUpHook: null,
      emotionalTrend: 'CALMER',
    });
    const service = await createService();

    await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(prisma.sessionSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ followUpHook: null }),
      }),
    );
  });

  it('still returns the summary id when embedding degrades', async () => {
    memory.embedAndStore.mockResolvedValue(false);
    const service = await createService();

    const result = await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    expect(result.summaryId).toBe('sum-1');
    expect(result.embedded).toBe(false);
  });

  it('summarizes vernacular USER messages from their stored English understanding', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        role: 'USER',
        content: 'ndu m agwula',
        aiPayload: {
          understanding: { englishTranslation: 'My life is finished' },
        },
      },
      { role: 'ASSISTANT', content: 'I hear you.', aiPayload: null },
    ]);
    const service = await createService();

    await service.summarizeConversation({
      studentId: 's1',
      conversationId: 'conv-1',
    });

    const sent = generateResponse.mock.calls[0][0] as { systemPrompt: string };
    expect(sent.systemPrompt).toContain('Student: My life is finished');
    expect(sent.systemPrompt).not.toContain('ndu m agwula');
  });
});
