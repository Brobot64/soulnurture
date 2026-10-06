import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AiJobKind, Prisma } from '@prisma/client';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AiService } from './ai.service.js';
import type {
  AiOrchestrationInput,
  SummarizeConversationInput,
} from './ai.service.js';

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
      // Idle close is isolated from the due-scan: a missing session_summary
      // table (migration not applied) must not starve REPLY jobs.
      try {
        await this.closeIdleConversations();
      } catch (error) {
        this.logger.warn(
          `Idle-close scan failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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

  /**
   * Idle close (Phase C step 3): ACTIVE conversations untouched for
   * memory.idleMinutes get closed here and a SUMMARY job queued, so every
   * real conversation ends up summarized even when the student never hits
   * close. Only conversations with at least one message qualify — an empty
   * conversation could only yield a hallucinated summary. Batch of 10 per
   * scan; the atomic UPDATE guards against races with a manual close.
   */
  private async closeIdleConversations() {
    const idleSeconds = Math.max(
      Math.round(this.aiConfig.memory.idleMinutes * 60),
      1,
    );
    const idle = await this.prisma.$queryRaw<
      { id: string; studentId: string }[]
    >`
      SELECT c.id, c."studentId" FROM conversation c
      WHERE c.status = 'ACTIVE'
        AND c."updatedAt" < NOW() - (interval '1 second' * ${idleSeconds})
        AND EXISTS (
          SELECT 1 FROM conversation_message m WHERE m."conversationId" = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_summary s WHERE s."conversationId" = c.id
        )
      ORDER BY c."updatedAt" ASC
      LIMIT 10`;

    for (const row of idle) {
      const closed = await this.prisma.$executeRaw<number>`
        UPDATE conversation
        SET status = 'CLOSED', "updatedAt" = NOW()
        WHERE id = ${row.id}::uuid AND status = 'ACTIVE'`;
      if (Number(closed) === 0) continue;

      await this.prisma.aiGenerationJob.create({
        data: {
          kind: 'SUMMARY',
          conversationMessageId: null,
          input: {
            studentId: row.studentId,
            conversationId: row.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.auditService.log({
        action: 'conversation.closed',
        entity: 'Conversation',
        entityId: row.id,
        meta: {
          reason: 'idle',
          idleMinutes: this.aiConfig.memory.idleMinutes,
        },
      });
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
      {
        id: string;
        conversationMessageId: string | null;
        kind: AiJobKind;
        attempts: number;
        input: unknown;
      }[]
    >`
      UPDATE ai_generation_job
      SET status = 'PROCESSING', "updatedAt" = NOW()
      WHERE id = ${jobId}::uuid AND status = 'PENDING'
      RETURNING id, "conversationMessageId", kind, attempts, input`;
    if (claimed.length === 0) return;
    const job = claimed[0];

    if (job.kind === 'SUMMARY') {
      await this.processSummaryJob(job);
      return;
    }

    const input = job.input as AiOrchestrationInput;
    try {
      const outcome = await this.aiService.generateAndApply(input);
      await this.prisma.conversationMessage.update({
        where: { id: job.conversationMessageId ?? '' },
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
      const moved = await this.rescheduleAfterFailure(job.id, job.attempts, error);
      if (!moved) return;

      if (moved.terminal) {
        await this.markMessageFailed(job.conversationMessageId ?? '', input);
        this.logger.warn(
          `AI job ${job.id} failed permanently after ${moved.attempts} attempts`,
        );
      } else {
        this.logger.warn(
          `AI job ${job.id} attempt ${moved.attempts} failed; retrying in ${moved.delay}s: ${moved.lastError}`,
        );
      }
    }
  }

  /** SUMMARY lane: writes the session summary that feeds memory recall. */
  private async processSummaryJob(job: {
    id: string;
    attempts: number;
    input: unknown;
  }) {
    const input = job.input as SummarizeConversationInput;
    try {
      await this.aiService.summarizeConversation(input);
      await this.prisma.$executeRaw<number>`
        UPDATE ai_generation_job
        SET status = 'SUCCEEDED', attempts = attempts + 1, lastError = NULL, "nextRetryAt" = NULL
        WHERE id = ${job.id}::uuid AND status = 'PROCESSING'`;
      this.logger.log(`AI job ${job.id} (SUMMARY) completed`);
    } catch (error) {
      const moved = await this.rescheduleAfterFailure(job.id, job.attempts, error);
      if (!moved) return;

      if (moved.terminal) {
        await this.auditService.log({
          action: 'ai_generation.exhausted',
          entity: 'SessionSummary',
          entityId: input.conversationId,
          meta: { lastError: moved.lastError },
        });
        this.logger.warn(
          `AI job ${job.id} (SUMMARY) failed permanently after ${moved.attempts} attempts`,
        );
      } else {
        this.logger.warn(
          `AI job ${job.id} (SUMMARY) attempt ${moved.attempts} failed; retrying in ${moved.delay}s: ${moved.lastError}`,
        );
      }
    }
  }

  /**
   * Shared failure scheduling (Postgres NOW() + interval arithmetic — never
   * app-side Date). Returns null when the job was already moved (crash during
   * processing); otherwise whether it landed terminal.
   */
  private async rescheduleAfterFailure(
    jobId: string,
    attemptsSoFar: number,
    error: unknown,
  ): Promise<{ attempts: number; terminal: boolean; lastError: string; delay: number } | null> {
    const attempts = attemptsSoFar + 1;
    const delaySeconds = this.aiConfig.async.retryDelaysMs.map((ms) =>
      Math.max(Math.round(ms / 1000), 1),
    );
    const lastError = error instanceof Error ? error.message : String(error);
    const terminal = attempts > delaySeconds.length;
    const delay =
      delaySeconds[Math.min(attempts, delaySeconds.length) - 1] ?? delaySeconds[0];

    const moved = await this.prisma.$queryRaw<{ status: string }[]>`
      UPDATE ai_generation_job
      SET ${
        terminal
          ? Prisma.sql`status = 'FAILED', attempts = ${attempts}, "lastError" = ${lastError}, "nextRetryAt" = NULL`
          : Prisma.sql`status = 'PENDING', attempts = ${attempts}, "lastError" = ${lastError}, "nextRetryAt" = NOW() + (interval '1 second' * ${delay})`
      }
      WHERE id = ${jobId}::uuid AND status = 'PROCESSING'
      RETURNING status`;
    if (moved.length === 0) return null;
    return { attempts, terminal, lastError, delay };
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
