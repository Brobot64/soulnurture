import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AiService } from './ai.service.js';
import type { AiOrchestrationInput } from './ai.service.js';

/**
 * Queued AI regeneration worker.
 *
 * When the first synchronous attempt fails, conversations.sendMessage leaves
 * an empathetic placeholder ASSISTANT message and a PENDING AiGenerationJob.
 * This worker scans the table, claims due jobs atomically, re-runs the same
 * orchestration, and rewrites the placeholder message in place — so the real
 * AI response arrives even when the student closed the window (the queue
 * lives in the database, not in a session).
 *
 * IMPORTANT: due/retry scheduling is evaluated with Postgres's own NOW() and
 * interval arithmetic, never with app-side Date objects — Prisma's DateTime
 * maps to naive `timestamp(3)` columns, so crossing client/DB clocks invites
 * timezone drift. Durations (retry delays, staleness bounds) are the only
 * app-side inputs and are converted to DB interval seconds.
 */
@Injectable()
export class AiWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiWorkerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly auditService: AuditService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  onModuleInit() {
    const { pollMs } = this.aiConfig.async;
    if (!pollMs || pollMs <= 0) {
      this.logger.warn('AI async worker disabled (AI_ASYNC_POLL_MS<=0)');
      return;
    }
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, pollMs);
    this.logger.log(`AI async worker started (scan every ${pollMs}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.reclaimStale();
      const due = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM ai_generation_job
        WHERE status = 'PENDING'
          AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW())
        ORDER BY "createdAt" ASC
        LIMIT 5`;
      for (const row of due) {
        await this.claimAndProcess(row.id);
      }
    } catch (error) {
      this.logger.error(
        `AI worker scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.scanning = false;
    }
  }

  /** PROCESSING jobs older than staleClaimMs are reclaimed (crash safety). */
  private async reclaimStale() {
    const staleCount = await this.prisma.$executeRaw<number>`
      UPDATE ai_generation_job
      SET status = 'PENDING', "updatedAt" = NOW()
      WHERE status = 'PROCESSING'
        AND "updatedAt" < NOW() - (interval '1 second' * ${Math.round(
          this.aiConfig.async.staleClaimMs / 1000,
        )})`;
    if (Number(staleCount) > 0) {
      this.logger.warn(`Reclaimed ${staleCount} stale AI job(s) to PENDING`);
    }
  }

  private async claimAndProcess(jobId: string) {
    // Atomic claim+reread in one statement; losing a race returns 0 rows.
    const claimed = await this.prisma.$queryRaw<
      { id: string; conversationMessageId: string; attempts: number; input: unknown }[]
    >`
      UPDATE ai_generation_job
      SET status = 'PROCESSING', "updatedAt" = NOW()
      WHERE id = ${jobId}::uuid AND status = 'PENDING'
      RETURNING id, "conversationMessageId", attempts, input`;
    if (claimed.length === 0) return;
    const job = claimed[0];

    const input = job.input as AiOrchestrationInput;
    try {
      const outcome = await this.aiService.generateAndApply(input);
      await this.prisma.conversationMessage.update({
        where: { id: job.conversationMessageId },
        data: {
          content: outcome.result.message,
          aiPayload: {
            ...outcome.result,
            applicationNotes: outcome.notes,
            viaAsyncRetry: true,
          } as Prisma.InputJsonValue,
          activeExerciseLabel:
            outcome.result.exerciseLabel ??
            (outcome.result.action === 'GROUNDING'
              ? 'ACT Grounding Exercise active'
              : null),
        },
      });
      await this.prisma.conversation.update({
        where: { id: input.conversationId },
        data: { updatedAt: new Date() },
      });
      await this.prisma.$executeRaw<number>`
        UPDATE ai_generation_job
        SET status = 'SUCCEEDED', attempts = attempts + 1, lastError = NULL, "nextRetryAt" = NULL
        WHERE id = ${job.id}::uuid AND status = 'PROCESSING'`;
      this.logger.log(`AI job ${job.id} completed`);
    } catch (error) {
      const attempts = job.attempts + 1;
      const delaySeconds = this.aiConfig.async.retryDelaysMs.map((ms) =>
        Math.max(Math.round(ms / 1000), 1),
      );
      const lastError = error instanceof Error ? error.message : String(error);
      const terminal = attempts > delaySeconds.length;
      const delay = delaySeconds[Math.min(attempts, delaySeconds.length) - 1] ?? delaySeconds[0];

      const moved = await this.prisma.$queryRaw<{ status: string }[]>`
        UPDATE ai_generation_job
        SET ${
          terminal
            ? Prisma.sql`status = 'FAILED', attempts = ${attempts}, "lastError" = ${lastError}, "nextRetryAt" = NULL`
            : Prisma.sql`status = 'PENDING', attempts = ${attempts}, "lastError" = ${lastError}, "nextRetryAt" = NOW() + (interval '1 second' * ${delay})`
        }
        WHERE id = ${job.id}::uuid AND status = 'PROCESSING'
        RETURNING status`;
      if (moved.length === 0) return;

      if (terminal) {
        await this.markMessageFailed(job.conversationMessageId, input);
        this.logger.warn(
          `AI job ${job.id} failed permanently after ${attempts} attempts`,
        );
      } else {
        this.logger.warn(
          `AI job ${job.id} attempt ${attempts} failed; retrying in ${delay}s: ${lastError}`,
        );
      }
    }
  }

  private async markMessageFailed(
    conversationMessageId: string,
    input: AiOrchestrationInput,
  ) {
    try {
      const message = await this.prisma.conversationMessage.findUnique({
        where: { id: conversationMessageId },
        select: { aiPayload: true },
      });
      const payload =
        message?.aiPayload && typeof message.aiPayload === 'object'
          ? (message.aiPayload as Record<string, unknown>)
          : {};
      await this.prisma.conversationMessage.update({
        where: { id: conversationMessageId },
        data: {
          aiPayload: {
            ...payload,
            asyncState: 'FAILED',
            applicationNotes: [
              ...(Array.isArray(payload.applicationNotes)
                ? (payload.applicationNotes as string[])
                : []),
              'AI generation failed after all retries; a human-support invite remains available.',
            ],
          } as Prisma.InputJsonValue,
        },
      });
      await this.auditService.log({
        action: 'ai_generation.exhausted',
        entity: 'AiGenerationJob',
        entityId: conversationMessageId,
        meta: { conversationId: input.conversationId },
      });
    } catch (error) {
      this.logger.error(
        `Could not mark AI message failed for ${conversationMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
