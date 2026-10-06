import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EmbeddingProvider } from '../providers/embedding/embedding.provider.js';

export interface MemorySummary {
  id: string;
  summary: string;
  topics: string[];
  emotionalTrend: string | null;
  createdAt: Date;
}

export interface MemoryRecall {
  recents: MemorySummary[];
  hooks: { followUpHook: string; createdAt: Date }[];
  similar: MemorySummary[];
}

/**
 * Raw-SQL owner of the pgvector-backed session-summary memory.
 *
 * The `embedding` column is `Unsupported("vector(1536)")` in the Prisma
 * schema (typing only), so every read/write here is `$queryRaw`/`$executeRaw`
 * with the vector passed as a `[n1,n2,...]` string literal cast to `::vector`.
 *
 * Degradation contract: embedding failures (missing key, network, missing
 * pgvector extension) never throw out of this repository — vector recall
 * silently degrades to recency-only and `embedAndStore` returns false. The
 * chat pipeline must keep working with a cold embedding provider.
 */
@Injectable()
export class MemoryRepository {
  private readonly logger = new Logger(MemoryRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingProvider,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async recall(params: {
    studentId: string;
    currentMessageText?: string;
  }): Promise<MemoryRecall> {
    const { studentId } = params;
    const mem = this.aiConfig.memory;
    const since = new Date(
      Date.now() - mem.recallDays * 24 * 60 * 60 * 1000,
    );
    const hookSince = new Date(Date.now() - mem.hookDays * 24 * 60 * 60 * 1000);

    const recents = await this.prisma.sessionSummary.findMany({
      where: { studentId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: mem.maxRecents,
      select: {
        id: true,
        summary: true,
        topics: true,
        emotionalTrend: true,
        createdAt: true,
      },
    });

    const hooks = (
      await this.prisma.sessionSummary.findMany({
        where: {
          studentId,
          followUpHook: { not: null },
          createdAt: { gte: hookSince },
        },
        orderBy: { createdAt: 'desc' },
        take: mem.maxHooks,
        select: { followUpHook: true, createdAt: true },
      })
    ).filter(
      (h): h is { followUpHook: string; createdAt: Date } =>
        h.followUpHook !== null,
    );

    let similar: MemorySummary[] = [];
    const text = params.currentMessageText?.trim();
    if (text) {
      similar = await this.similarSummaries(studentId, text, since);
    }

    // A summary should not appear twice (once from recency, once from vector).
    const recentIds = new Set(recents.map((r) => r.id));
    similar = similar.filter((s) => !recentIds.has(s.id));

    return { recents, hooks, similar };
  }

  /** Best-effort embedding write after a summary is persisted. Returns false
   * (and logs) when the embedding provider is unavailable — the row stays
   * recallable via recency. */
  async embedAndStore(summaryId: string, text: string): Promise<boolean> {
    try {
      const vector = await this.embedding.embed(text);
      const literal = `[${vector.join(',')}]`;
      await this.prisma.$executeRaw`
        UPDATE session_summary
        SET embedding = ${literal}::vector
        WHERE id = ${summaryId}::uuid`;
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not embed session summary ${summaryId}: ${
          error instanceof Error ? error.message : String(error)
        } — memory degrades to recency-only`,
      );
      return false;
    }
  }

  private async similarSummaries(
    studentId: string,
    text: string,
    since: Date,
  ): Promise<MemorySummary[]> {
    const mem = this.aiConfig.memory;
    try {
      const vector = await this.embedding.embed(text);
      const literal = `[${vector.join(',')}]`;
      const sinceSeconds = Math.max(
        Math.round((Date.now() - since.getTime()) / 1000),
        1,
      );
      const rows = await this.prisma.$queryRaw<
        (MemorySummary & { score: number })[]
      >`
        SELECT id, summary, topics, "emotionalTrend", "createdAt",
               1 - (embedding <=> ${literal}::vector) AS score
        FROM session_summary
        WHERE "studentId" = ${studentId}::uuid
          AND "createdAt" >= NOW() - (interval '1 second' * ${sinceSeconds})
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector
        LIMIT ${mem.maxSimilar * 2}`;
      return rows
        .filter((row) => Number(row.score) >= mem.minSimilarity)
        .slice(0, mem.maxSimilar);
    } catch (error) {
      this.logger.warn(
        `Vector recall unavailable for student ${studentId}: ${
          error instanceof Error ? error.message : String(error)
        } — falling back to recency-only`,
      );
      return [];
    }
  }
}
