import { Test } from '@nestjs/testing';
import { AiContextService } from './ai-context.service.js';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { MemoryRepository } from '../memory/memory.repository.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const aiConfigStub = {
  context: { messageLimit: 12, characterLimit: 12_000 },
} as unknown as AiConfig;

const createdAt = new Date('2026-10-01T10:00:00Z');
const summary = (id: string) => ({
  id,
  summary: `Summary ${id}`,
  topics: ['exam'],
  emotionalTrend: 'CALMER',
  createdAt,
});

describe('AiContextService', () => {
  let service: AiContextService;
  let prisma: {
    studentProfile: { findUnique: ReturnType<typeof vi.fn> };
    emotionalCheckIn: { findUnique: ReturnType<typeof vi.fn> };
    conversationMessage: { findMany: ReturnType<typeof vi.fn> };
    wellbeingResource: { findMany: ReturnType<typeof vi.fn> };
  };
  let memory: { recall: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      studentProfile: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ firstName: 'Amina', preferredLanguage: 'en' }),
      },
      emotionalCheckIn: { findUnique: vi.fn() },
      conversationMessage: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ role: 'USER', content: 'hello' }]),
      },
      wellbeingResource: { findMany: vi.fn().mockResolvedValue([]) },
    };
    memory = { recall: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AiContextService,
        { provide: PrismaService, useValue: prisma },
        { provide: MemoryRepository, useValue: memory },
        { provide: AI_CONFIG, useValue: aiConfigStub },
      ],
    }).compile();
    service = module.get(AiContextService);
  });

  it('sets carriedContext to null when the student has no memory yet', async () => {
    memory.recall.mockResolvedValue({ recents: [], hooks: [], similar: [] });

    const ctx = await service.build({
      studentId: 's1',
      conversationId: 'c1',
      currentMessageText: 'exams are coming',
    });

    expect(ctx.carriedContext).toBeNull();
    expect(memory.recall).toHaveBeenCalledWith({
      studentId: 's1',
      currentMessageText: 'exams are coming',
    });
  });

  it('merges recents and vector-similar summaries (capped at four) plus hooks', async () => {
    memory.recall.mockResolvedValue({
      recents: [summary('r1'), summary('r2'), summary('r3')],
      similar: [summary('s1'), summary('s2')],
      hooks: [{ followUpHook: 'Ask how the exam went.', createdAt }],
    });

    const ctx = await service.build({ studentId: 's1', conversationId: 'c1' });

    expect(ctx.carriedContext).not.toBeNull();
    expect(ctx.carriedContext!.summaries.map((s) => s.id)).toEqual([
      'r1',
      'r2',
      'r3',
      's1',
    ]);
    expect(ctx.carriedContext!.followUpHooks).toEqual([
      { followUpHook: 'Ask how the exam went.', createdAt },
    ]);
  });

  it('carries hooks even when no summaries were recalled', async () => {
    memory.recall.mockResolvedValue({
      recents: [],
      similar: [],
      hooks: [{ followUpHook: 'Check in gently.', createdAt }],
    });

    const ctx = await service.build({ studentId: 's1', conversationId: 'c1' });

    expect(ctx.carriedContext).toEqual({
      summaries: [],
      followUpHooks: [{ followUpHook: 'Check in gently.', createdAt }],
    });
  });

  it('pivots stored turns to their English sources for the model window', async () => {
    memory.recall.mockResolvedValue({ recents: [], hooks: [], similar: [] });
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        role: 'ASSISTANT',
        content: 'Mo wà níbí pẹ̀lú rẹ.',
        language: 'yo',
        aiPayload: { render: { englishSource: 'I am here with you.' } },
      },
      {
        role: 'USER',
        content: 'Mo ti rẹ̀ rẹ̀ lónìí',
        language: 'yo',
        aiPayload: {
          understanding: { englishTranslation: 'I am tired today.' },
        },
      },
      { role: 'USER', content: 'hello', language: 'en', aiPayload: null },
    ]);

    const ctx = await service.build({ studentId: 's1', conversationId: 'c1' });

    expect(ctx.recentConversation).toEqual([
      { role: 'USER', content: 'hello', language: 'en' },
      { role: 'USER', content: 'I am tired today.', language: 'yo' },
      { role: 'ASSISTANT', content: 'I am here with you.', language: 'yo' },
    ]);
  });

  it('keeps raw content for turns without a pivot payload', async () => {
    memory.recall.mockResolvedValue({ recents: [], hooks: [], similar: [] });
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        role: 'ASSISTANT',
        content: 'Morning! How are you?',
        language: 'en',
        aiPayload: { applicationNotes: [] },
      },
      { role: 'USER', content: 'Good morning', language: null, aiPayload: {} },
    ]);

    const ctx = await service.build({ studentId: 's1', conversationId: 'c1' });

    expect(ctx.recentConversation).toEqual([
      { role: 'USER', content: 'Good morning', language: null },
      { role: 'ASSISTANT', content: 'Morning! How are you?', language: 'en' },
    ]);
  });
});
