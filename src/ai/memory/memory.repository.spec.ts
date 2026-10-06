import { Test } from '@nestjs/testing';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EmbeddingProvider } from '../providers/embedding/embedding.provider.js';
import { MemoryRepository } from './memory.repository.js';

const aiConfigStub = {
  memory: {
    idleMinutes: 120,
    recallDays: 30,
    hookDays: 14,
    maxRecents: 2,
    maxHooks: 3,
    maxSimilar: 2,
    minSimilarity: 0.8,
  },
} as unknown as AiConfig;

const createdAt = new Date('2026-10-01T10:00:00Z');

const recent = (id: string) => ({
  id,
  summary: `Summary ${id}`,
  topics: ['exam'],
  emotionalTrend: 'CALMER',
  createdAt,
});

describe('MemoryRepository', () => {
  let repository: MemoryRepository;
  let prisma: {
    sessionSummary: { findMany: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };
  let embedding: { embed: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      sessionSummary: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    embedding = { embed: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        MemoryRepository,
        { provide: PrismaService, useValue: prisma },
        { provide: EmbeddingProvider, useValue: embedding },
        { provide: AI_CONFIG, useValue: aiConfigStub },
      ],
    }).compile();
    repository = module.get(MemoryRepository);
  });

  it('assembles recents + hooks and dedupes vector-similar rows against recents', async () => {
    prisma.sessionSummary.findMany
      .mockResolvedValueOnce([recent('r1'), recent('r2')]) // recents
      .mockResolvedValueOnce([
        { followUpHook: 'Ask how the exam went.', createdAt },
      ]); // hooks
    embedding.embed.mockResolvedValue([0.1, 0.2]);
    prisma.$queryRaw.mockResolvedValue([
      { ...recent('r2'), score: 0.95 }, // duplicate of a recent
      { ...recent('s1'), score: 0.9 },
      { ...recent('s2'), score: 0.5 }, // below minSimilarity 0.8
    ]);

    const result = await repository.recall({
      studentId: 'student-1',
      currentMessageText: 'exams are coming',
    });

    expect(result.recents.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(result.hooks).toEqual([
      { followUpHook: 'Ask how the exam went.', createdAt },
    ]);
    expect(result.similar.map((s) => s.id)).toEqual(['s1']);
    expect(prisma.sessionSummary.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 2 }),
    );
    expect(prisma.sessionSummary.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ take: 3 }),
    );
  });

  it('skips vector recall entirely when there is no current message text', async () => {
    prisma.sessionSummary.findMany.mockResolvedValue([]);

    const result = await repository.recall({ studentId: 'student-1' });

    expect(embedding.embed).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(result).toEqual({ recents: [], hooks: [], similar: [] });
  });

  it('degrades to recency-only when the embedding provider fails', async () => {
    prisma.sessionSummary.findMany
      .mockResolvedValueOnce([recent('r1')])
      .mockResolvedValueOnce([]);
    embedding.embed.mockRejectedValue(new Error('no embedding key'));

    const result = await repository.recall({
      studentId: 'student-1',
      currentMessageText: 'exams are coming',
    });

    expect(result.recents.map((r) => r.id)).toEqual(['r1']);
    expect(result.similar).toEqual([]);
  });

  it('degrades to recency-only when the vector query fails (e.g. no pgvector)', async () => {
    prisma.sessionSummary.findMany
      .mockResolvedValueOnce([recent('r1')])
      .mockResolvedValueOnce([]);
    embedding.embed.mockResolvedValue([0.1, 0.2]);
    prisma.$queryRaw.mockRejectedValue(new Error('type "vector" does not exist'));

    const result = await repository.recall({
      studentId: 'student-1',
      currentMessageText: 'exams are coming',
    });

    expect(result.similar).toEqual([]);
    expect(result.recents.map((r) => r.id)).toEqual(['r1']);
  });

  it('stores the embedding as a vector literal for the summary row', async () => {
    embedding.embed.mockResolvedValue([1, 2, 3]);

    const stored = await repository.embedAndStore('sum-1', 'summary text');

    expect(stored).toBe(true);
    const call = prisma.$executeRaw.mock.calls[0] as unknown[];
    const sql = (call[0] as string[]).join('?');
    expect(sql).toContain('SET embedding');
    expect(call[1]).toBe('[1,2,3]');
    expect(call[2]).toBe('sum-1');
  });

  it('returns false (never throws) when embedding the summary fails', async () => {
    embedding.embed.mockRejectedValue(new Error('network down'));

    const stored = await repository.embedAndStore('sum-1', 'summary text');

    expect(stored).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
