import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import type { AiGenerationResult } from './ai-provider.interface.js';

/**
 * Records per-day, per-provider generation counters into AiUsageDaily.
 *
 * Raw SQL on purpose: `day` is always the database's CURRENT_DATE (never an
 * app-side Date — timezone skew would split a day's counters). Metering is
 * best-effort: a failed counter must never break a student's conversation,
 * so reads/writes fail open and return null.
 */
@Injectable()
export class AiUsageMeterService {
  private readonly logger = new Logger(AiUsageMeterService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  /** Today's recorded request count for a provider; null when the read fails. */
  async countFor(provider: string): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRaw<{ requests: number }[]>`
        SELECT requests FROM "ai_usage_daily"
        WHERE day = CURRENT_DATE AND provider = ${provider}
      `;
      return rows[0]?.requests ?? 0;
    } catch (error) {
      this.logger.warn(
        `Usage count read failed for "${provider}"; failing open`,
        error,
      );
      return null;
    }
  }

  /**
   * Upserts one generation into today's row. Returns the post-write request
   * count (the boundary signal for the daily budget audit), or null when the
   * write fails.
   */
  async record(
    provider: string,
    usage: AiGenerationResult['usage'],
  ): Promise<number | null> {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const price = this.aiConfig.pricing.usdCentsPer1M[provider] ?? {
      input: 0,
      output: 0,
    };
    const estimatedUsdCents = Math.ceil(
      (inputTokens / 1_000_000) * price.input +
        (outputTokens / 1_000_000) * price.output,
    );

    try {
      const rows = await this.prisma.$queryRaw<{ requests: number }[]>`
        INSERT INTO "ai_usage_daily"
          (id, day, provider, requests, "inputTokens", "outputTokens", "estimatedUsdCents")
        VALUES
          (gen_random_uuid(), CURRENT_DATE, ${provider}, 1, ${inputTokens}, ${outputTokens}, ${estimatedUsdCents})
        ON CONFLICT (day, provider) DO UPDATE SET
          requests = "ai_usage_daily".requests + 1,
          "inputTokens" = "ai_usage_daily"."inputTokens" + ${inputTokens},
          "outputTokens" = "ai_usage_daily"."outputTokens" + ${outputTokens},
          "estimatedUsdCents" = "ai_usage_daily"."estimatedUsdCents" + ${estimatedUsdCents},
          "updatedAt" = NOW()
        RETURNING requests
      `;
      return rows[0]?.requests ?? null;
    } catch (error) {
      this.logger.warn(
        `Usage record failed for "${provider}"; failing open`,
        error,
      );
      return null;
    }
  }
}
