import { Test } from '@nestjs/testing';
import { AiService } from './ai.service.js';
import { AiGenerationError } from './ai.errors.js';
import { AiContextService } from './context/ai-context.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_PROVIDER } from './providers/ai-provider.interface.js';
import { IntentEngineService } from './intents/intent-engine.service.js';
import type { AiGenerationResult } from './providers/ai-provider.interface.js';

const ctx = {
  student: { firstName: 'A', preferredLanguage: 'en' },
  currentCheckIn: null,
  recentConversation: [],
  relevantReflection: null,
  relevantResources: [
    { id: 'r1', title: 'Breath', type: 'SOMATIC_EXERCISE', category: 'GROUNDING', description: 'Breathing guide' },
  ],
  currentJourneyStep: 2,
};

function validModelResult(overrides: Partial<AiGenerationResult> = {}): AiGenerationResult {
  return {
    message: 'hello',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
    ...overrides,
  };
}

const orchestrationInput = {
  studentId: 's1',
  conversationId: 'c1',
  userContent: 'hi',
  studentRef: 'Jude O.',
  classLabel: null,
};

describe('AiService.generateAndApply', () => {
  let prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  let auditService: { log: ReturnType<typeof vi.fn> };

  function createModule(providerValue: {
    generateResponse: (...args: unknown[]) => Promise<unknown>;
    transcribeAudio: (...args: unknown[]) => Promise<unknown>;
  }) {
    return Test.createTestingModule({
      providers: [
        AiService,
        { provide: AI_PROVIDER, useValue: providerValue },
        { provide: AiContextService, useValue: { build: async () => ctx } },
        IntentEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
  }

  beforeEach(() => {
    prisma = {
      supportFlag: { findFirst: vi.fn(), create: vi.fn() },
    };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  });

  it('strips unknown resource ids from provider output', async () => {
    const provider = {
      generateResponse: async () =>
        validModelResult({ resource: { recommended: true, resourceId: 'NOT-ALLOWED' } }),
      transcribeAudio: async () => ({ text: 'x' }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    const outcome = await service.generateAndApply(orchestrationInput);
    expect(outcome.result.resource.recommended).toBe(false);
    expect(outcome.result.resource.resourceId).toBeNull();
    expect(outcome.notes.join(' ')).toContain('unapproved');
  });

  it('keeps an approved resource recommendation and marks the result COMPLETE', async () => {
    const provider = {
      generateResponse: async () =>
        validModelResult({
          emotion: { detected: 'calm', confidence: 0.9 },
          reflection: { question: 'why?', insight: null },
          resource: { recommended: true, resourceId: 'r1' },
          action: 'RESOURCE',
        }),
      transcribeAudio: async () => ({ text: 'x' }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    const outcome = await service.generateAndApply(orchestrationInput);
    expect(outcome.result.resource).toEqual({ recommended: true, resourceId: 'r1' });
    expect(outcome.result.action).toBe('RESOURCE');
    expect(outcome.result.asyncState).toBe('COMPLETE');
    expect(outcome.verdict).toBeNull();
  });

  it('throws AiGenerationError when the provider itself fails', async () => {
    const provider = {
      generateResponse: async () => {
        throw new Error('boom');
      },
      transcribeAudio: async () => ({ text: 'x' }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    await expect(service.generateAndApply(orchestrationInput)).rejects.toThrow(
      AiGenerationError,
    );
  });

  it('throws AiGenerationError when output fails schema validation', async () => {
    const provider = {
      generateResponse: async () => ({ notValid: true }),
      transcribeAudio: async () => ({ text: 'x' }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    await expect(service.generateAndApply(orchestrationInput)).rejects.toThrow(
      AiGenerationError,
    );
  });

  it('crisis keywords persist a TIER_3 server-policy flag and flip human support', async () => {
    prisma.supportFlag.findFirst = vi.fn().mockResolvedValue(null);
    prisma.supportFlag.create = vi.fn().mockResolvedValue({ id: 'flag-1' });
    const provider = {
      generateResponse: async () => validModelResult(),
      transcribeAudio: async () => ({ text: 'x' }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    const outcome = await service.generateAndApply({
      ...orchestrationInput,
      userContent: 'I want to kill myself and end it all',
    });
    expect(outcome.verdict?.intentId).toBe('SUICIDAL_IDEATION');
    expect(outcome.result.supportFlag.candidate).toBe(true);
    expect(prisma.supportFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          severity: 'TIER_3_ACUTE',
          source: 'SERVER_POLICY',
          intentId: 'SUICIDAL_IDEATION',
        }),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_flag.auto_created' }),
    );
    expect(outcome.result.humanSupport.recommended).toBe(true);
    expect(outcome.result.action).toBe('HUMAN_SUPPORT');
    expect(outcome.result.message).toContain('you matter');
  });

  it('transcribes voice input through the provider', async () => {
    const provider = {
      generateResponse: async () => validModelResult(),
      transcribeAudio: async (input: { filename: string }) => ({
        text: `transcribed:${input.filename}`,
      }),
    };
    const module = await createModule(provider);
    const service = module.get(AiService);
    const result = await service.transcribe({
      buffer: Buffer.from('x'),
      filename: 'audio.webm',
      mimeType: 'audio/webm',
    });
    expect(result.text).toBe('transcribed:audio.webm');
  });
});
