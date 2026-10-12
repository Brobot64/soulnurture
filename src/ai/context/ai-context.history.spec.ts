import { Test } from '@nestjs/testing';
import { AiContextService } from './ai-context.service.js';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { MemoryRepository } from '../memory/memory.repository.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Rows come back newest-first, as the real query orders them. */
type Row = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  language?: string | null;
  aiPayload?: unknown;
};

describe('AiContextService — conversation history (current-turn fixes)', () => {
  let service: AiContextService;
  let rows: Row[];
  let findMany: ReturnType<typeof vi.fn>;

  async function build(
    charLimit = 12_000,
    excludeMessageId?: string | null,
  ) {
    const module = await Test.createTestingModule({
      providers: [
        AiContextService,
        {
          provide: PrismaService,
          useValue: {
            studentProfile: {
              findUnique: vi.fn().mockResolvedValue({ firstName: 'A', preferredLanguage: 'en' }),
            },
            emotionalCheckIn: { findUnique: vi.fn() },
            conversationMessage: { findMany },
            wellbeingResource: { findMany: vi.fn().mockResolvedValue([]) },
          },
        },
        {
          provide: MemoryRepository,
          useValue: { recall: vi.fn().mockResolvedValue({ recents: [], similar: [], hooks: [] }) },
        },
        {
          provide: AI_CONFIG,
          useValue: { context: { messageLimit: 12, characterLimit: charLimit } } as unknown as AiConfig,
        },
      ],
    }).compile();
    service = module.get(AiContextService);
    return service.build({
      studentId: 's1',
      conversationId: 'c1',
      excludeMessageId,
    });
  }

  beforeEach(() => {
    rows = [];
    findMany = vi.fn(async (args: { where: { id?: { not: string } } }) =>
      // Mirror the query: honour the id exclusion, return a fresh array each call.
      structuredClone(rows).filter((r) =>
        args.where.id ? r.id !== args.where.id.not : true,
      ),
    );
  });

  it('leaves the current student message out of history when it is excluded by id', async () => {
    rows = [
      { id: 'cur', role: 'USER', content: 'Ina so in kashe kaina yanzu' },
      { id: 'a1', role: 'ASSISTANT', content: 'Na ji bakin cikin jin haka.' },
      { id: 'u1', role: 'USER', content: 'Ina jin bakin ciki' },
    ];

    const ctx = await build(12_000, 'cur');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'cur' } }) }),
    );
    // Chronological: the oldest student message first, the current turn absent.
    expect(ctx.recentConversation.map((m) => m.content)).toEqual([
      'Ina jin bakin ciki',
      'Na ji bakin cikin jin haka.',
    ]);
  });

  it('keeps the NEWEST messages when the character budget is tight', async () => {
    rows = [
      { id: 'u3', role: 'USER', content: 'newest message here' },
      { id: 'a2', role: 'ASSISTANT', content: 'a middling reply' },
      { id: 'u1', role: 'USER', content: 'oldest message of all, long text' },
    ];

    // Budget fits the newest two messages only.
    const ctx = await build(40);

    expect(ctx.recentConversation.map((m) => m.content)).toEqual([
      'a middling reply',
      'newest message here',
    ]);
  });

  it('drops queued holding placeholders so the model never reads them as its own reply', async () => {
    rows = [
      { id: 'a2', role: 'ASSISTANT', content: 'Thank you for sharing…', aiPayload: { asyncState: 'PENDING_AI' } },
      { id: 'u1', role: 'USER', content: 'I feel tired' },
    ];

    const ctx = await build();

    expect(ctx.recentConversation.map((m) => m.content)).toEqual(['I feel tired']);
  });

  it('carries each message language so the model can see which language a turn was in', async () => {
    rows = [
      { id: 'a1', role: 'ASSISTANT', content: 'Ina nan.', language: 'ha' },
      { id: 'u1', role: 'USER', content: 'Ina jin tsoro', language: 'ha' },
      { id: 'u0', role: 'USER', content: 'hello', language: 'en' },
    ];

    const ctx = await build();

    expect(ctx.recentConversation.map((m) => m.language)).toEqual(['en', 'ha', 'ha']);
  });

  it('treats rows without a language as null (older messages)', async () => {
    rows = [{ id: 'u1', role: 'USER', content: 'hi' }];

    const ctx = await build();

    expect(ctx.recentConversation[0].language).toBeNull();
  });
});
