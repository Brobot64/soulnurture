import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HistoryDeletionScope, Prisma } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** The owner's ruling of 2026-11-04: the student decides, and the undo window
 * is 24 hours. Minutes, env-overridable, so a test can wait it out instead of
 * faking the clock. */
export const DEFAULT_UNDO_WINDOW_MINUTES = 1440;

/** Held a day and re-checked: the erasure waits rather than running while the
 * student cannot sign in to stop it. */
const HOLD_RETRY_AFTER_MINUTES = 360;

/** The notice a scoped erasure leaves behind. The account-wide erasure cannot
 * notify anyone — there is no account left to notify, which is the point. */
export const HISTORY_DELETION_EXECUTED_TYPE = 'HISTORY_DELETION_EXECUTED';

/** Tables holding a row of this student by direct FK. */
const STUDENT_OWNED_TABLES = [
  'emotional_check_in',
  'conversation',
  'chat_thread',
  'support_flag',
  'support_request',
  'follow_up',
  'journal_entry',
  'toolbox_item',
  'resource_feedback',
  'session_summary',
  'activity_session',
  'consent_record',
  'privacy_preference',
  'check_in_feedback',
  'history_deletion_request',
] as const;

interface DueRow {
  id: string;
  studentId: string;
  scope: HistoryDeletionScope;
  beforeDate: Date | null;
  checkInIds: string[];
}

interface StudentOwner {
  userId: string;
  email: string;
  phone: string | null;
  deactivatedAt: Date | null;
  schoolId: string | null;
  schoolStatus: string | null;
}

type PurgeOutcome = 'erased' | 'executed' | 'held' | 'skipped';

/**
 * Epic H's erasure engine: the code that turns a stored deletion ask into
 * removed rows.
 *
 * Three rules shape it.
 *
 * 1. The student decides. `create()` stamps `scheduledPurgeAt` and this worker
 *    honours it; staff are informed, not consulted.
 * 2. The 24 hours only mean something if the student can still sign in to use
 *    them. A due erasure against a deactivated account, or a suspended school,
 *    is HELD with the reason recorded and retried later. Erasing someone who
 *    had no way to stop it is not what was promised to them.
 * 3. One ask, one Postgres transaction. A half-erasure — the profile gone but
 *    the notification sweep not — is the one outcome this job must not leave
 *    behind; a rolled-back transaction stays due and is retried.
 *
 * Due-ness is compared with Postgres's own `NOW()`, like the AI worker, and the
 * schedule columns are `TIMESTAMPTZ`, so a written Date and a `NOW()` test are
 * on the same clock regardless of the server's timezone.
 */
@Injectable()
export class HistoryPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryPurgeService.name);
  private readonly pollMs: number;
  private readonly undoWindowMinutes: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {
    this.pollMs = Number(config.get<string>('HISTORY_PURGE_POLL_MS') ?? 60_000);
    this.undoWindowMinutes = Number(
      config.get<string>('HISTORY_DELETION_UNDO_MINUTES') ??
        DEFAULT_UNDO_WINDOW_MINUTES,
    );
  }

  /** The window a student is told about, in minutes — 1440 unless overridden. */
  get undoWindowMinutesValue(): number {
    return this.undoWindowMinutes;
  }

  /**
   * When a new ask becomes an erasure. A JS Date is safe here precisely because
   * the column is `TIMESTAMPTZ`: it round-trips as an instant, not a naive
   * wall-clock value.
   */
  scheduledPurgeAt(from: Date = new Date()): Date {
    return new Date(from.getTime() + this.undoWindowMinutes * 60_000);
  }

  onModuleInit() {
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) {
      this.logger.warn(
        'History purge worker disabled (HISTORY_PURGE_POLL_MS<=0): deletion asks will be stored but never executed',
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.pollMs);
    this.logger.log(
      `History purge worker started (scan every ${this.pollMs}ms, undo window ${this.undoWindowMinutes}min)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass over the due queue.
   *
   * `scheduledPurgeAt IS NOT NULL` is a real guard, not belt-and-braces: asks
   * filed before this engine exists were never promised an automatic erasure,
   * so honouring one now would invent a schedule that never existed.
   */
  async scanOnce(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const due = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM history_deletion_request
        WHERE "purgedAt" IS NULL
          AND "cancelledAt" IS NULL
          AND "scheduledPurgeAt" IS NOT NULL
          AND "scheduledPurgeAt" <= NOW()
        ORDER BY "scheduledPurgeAt" ASC
        LIMIT 5`;
      let done = 0;
      for (const row of due) {
        const outcome = await this.purgeOne(row.id);
        if (outcome !== 'skipped') done += 1;
      }
      return done;
    } catch (error) {
      this.logger.error(
        `History purge scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Execute one ask. Idempotent by construction: the row lock plus the
   * `purgedAt IS NULL` guard means a second call on the same id does nothing,
   * and a crash anywhere inside rolls the whole thing back and leaves the ask
   * due for the next pass.
   */
  async purgeOne(requestId: string): Promise<PurgeOutcome> {
    let result: PurgeResult;
    try {
      result = await this.prisma.$transaction(
        (tx) => this.purgeInTransaction(tx, requestId),
        { timeout: 120_000, maxWait: 10_000 },
      );
    } catch (error) {
      this.logger.error(
        `Deletion request ${requestId} failed and rolled back; nothing was removed and it stays due: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'skipped';
    }
    if (result.notifyUserId) await this.announce(result);
    if (result.outcome === 'held') {
      this.logger.warn(
        `Deletion request ${requestId} held (${result.holdCode}): the account cannot sign in, so the undo window could not be honoured`,
      );
    }
    return result.outcome;
  }

  private async purgeInTransaction(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<PurgeResult> {
    // FOR UPDATE SKIP LOCKED: a second worker, or a student cancelling in the
    // same instant, loses the race cleanly instead of double-erasing.
    const [row] = await tx.$queryRaw<DueRow[]>`
      SELECT id, "studentId", scope, "beforeDate", "checkInIds"
      FROM history_deletion_request
      WHERE id = ${requestId}::uuid
        AND "purgedAt" IS NULL
        AND "cancelledAt" IS NULL
      FOR UPDATE SKIP LOCKED`;
    if (!row) return noop('skipped');

    const owner = await this.resolveOwner(tx, row.studentId);
    if (!owner) {
      // The student row is already gone, so this ask has nothing left to erase.
      // Close it rather than leave a permanently due row in the queue.
      await tx.$executeRaw`
        UPDATE history_deletion_request
        SET "purgedAt" = NOW(), "holdReason" = NULL
        WHERE id = ${requestId}::uuid`;
      return noop('executed');
    }

    const hold = holdCodeFor(owner);
    if (hold) {
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE history_deletion_request
          SET "holdReason" = ${hold},
              "scheduledPurgeAt" = NOW() + ${HOLD_RETRY_AFTER_MINUTES} * interval '1 minute'
          WHERE id = ${requestId}::uuid`,
      );
      return { ...noop('held'), holdCode: hold };
    }

    return row.scope === HistoryDeletionScope.ALL_HISTORY
      ? await this.eraseAccount(tx, row, owner)
      : await this.eraseScope(tx, row, owner);
  }

  /**
   * ALL_HISTORY — the owner's "all like it never exists". This removes the
   * account, not merely the wellbeing rows, and it reaches the copies a foreign
   * key cannot: audit rows that name the student, staff notifications quoting
   * their first name and their words, queued AI jobs holding their ids in a jsonb
   * column, and Better Auth verifications keyed by email or phone.
   */
  private async eraseAccount(
    tx: Prisma.TransactionClient,
    row: DueRow,
    owner: StudentOwner,
  ): Promise<PurgeResult> {
    const counts = await tx.$queryRaw<
      { checkIns: number; conversations: number }[]
    >`
      SELECT
        (SELECT count(*) FROM emotional_check_in WHERE "studentId" = ${row.studentId}::uuid)::int AS "checkIns",
        (SELECT count(*) FROM conversation WHERE "studentId" = ${row.studentId}::uuid)::int AS "conversations"`;
    const removed = counts[0] ?? { checkIns: 0, conversations: 0 };

    await this.applySweep(tx, accountTargets(row.studentId, owner));

    // student_profile cascades over every wellbeing table — check-ins with their
    // answers and feedback, conversations with messages, reports and summaries
    // (pgvector embedding included), flags, requests, follow-ups, journals,
    // toolbox, consent, privacy, chat threads with messages, activities — and
    // over this request row itself.
    await tx.$executeRaw`
      DELETE FROM student_profile WHERE id = ${row.studentId}::uuid`;
    // Then the identity: sessions, accounts (the password hash) and the
    // student's own notifications cascade from the user row.
    await tx.$executeRaw`
      DELETE FROM "user" WHERE id = ${owner.userId}::uuid`;

    await this.recordErasure(tx, row, owner.schoolId, removed, true);
    return {
      outcome: 'erased',
      erasedAccount: true,
      removedCheckIns: removed.checkIns,
      removedConversations: removed.conversations,
      // No notify: the recipient of that notification no longer exists.
      notifyUserId: null,
      scope: row.scope,
    };
  }

  /**
   * BEFORE_DATE / SELECTED_CHECK_INS — the student stays, so the ask must not
   * take more than it named. Out go the entries in scope and the reflections
   * that existed only as those entries; the school's safeguarding residue (a
   * flag's frozen statement snapshot, a request's opening message) stays, which
   * is the position the schema already encodes.
   */
  private async eraseScope(
    tx: Prisma.TransactionClient,
    row: DueRow,
    owner: StudentOwner,
  ): Promise<PurgeResult> {
    const studentId = row.studentId;
    const inScope =
      row.scope === HistoryDeletionScope.BEFORE_DATE
        ? beforeDateScope(row, studentId)
        : selectedScope(row, studentId);

    const counts = await tx.$queryRaw<
      { checkIns: number; conversations: number }[]
    >`
      SELECT
        (SELECT count(*) FROM emotional_check_in WHERE ${inScope.checkIns})::int AS "checkIns",
        (SELECT count(*) FROM conversation WHERE ${inScope.conversations})::int AS "conversations"`;
    const removed = counts[0] ?? { checkIns: 0, conversations: 0 };

    await this.applySweep(tx, scopeTargets(owner, inScope));

    // Conversations first, while `checkInId` still points at the entries — the
    // link is SetNull, so deleting the check-ins first would blind this filter.
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM conversation WHERE ${inScope.conversations}`,
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM emotional_check_in WHERE ${inScope.checkIns}`,
    );

    // chat_thread.entryCheckInId is a plain uuid column with NO relation, so a
    // deleted entry leaves a dangling id beside an AI-composed note the staff
    // request pool still shows (deletion spec §2.1). Nulling both repairs it,
    // including dangling ids left by any earlier manual removal.
    await tx.$executeRaw`
      UPDATE chat_thread t
      SET "entryCheckInId" = NULL, "aiEntrySummary" = NULL
      WHERE t."studentId" = ${studentId}::uuid
        AND t."entryCheckInId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM emotional_check_in e WHERE e.id = t."entryCheckInId"
        )`;

    await this.recordErasure(tx, row, owner.schoolId, removed, false);
    return {
      outcome: 'executed',
      erasedAccount: false,
      removedCheckIns: removed.checkIns,
      removedConversations: removed.conversations,
      notifyUserId: owner.userId,
      scope: row.scope,
    };
  }

  /**
   * The copies a cascade cannot reach — data about this student that lives in
   * another person's row (a staff notification quoting them), in a text column
   * with no foreign key (an audit `entityId`, a job's jsonb `input`), or in a
   * table keyed by their contact detail (Better Auth's `verification`).
   *
   * Runs BEFORE the rows themselves go, because every subquery here finds them
   * through the student's own rows. `targets` says how wide the net is: the
   * account erasure sweeps everything naming the person, a scoped erasure sweeps
   * only what names the rows leaving — the student stays, so their own audit
   * trail stays with them.
   */
  private async applySweep(
    tx: Prisma.TransactionClient,
    targets: SweepTargets,
  ): Promise<void> {
    // Audit rows traceable to the student or to a leaving row. What survives is
    // the school's own operational log — an alert was raised on such a date —
    // since `meta` carries uuids and booleans, never names or content.
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM audit_log WHERE ${targets.audit}`,
    );

    // Staff notifications hold the student's first name, their class and the
    // words that triggered the alert. The most personal copy outside the
    // student's own tables, and no foreign key reaches it.
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM notification WHERE ${targets.notification}`,
    );

    // Queued regeneration/summary jobs carry the student's ids in `input`. Only
    // jobs bound to a message cascade; SUMMARY jobs have no FK at all.
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ai_generation_job WHERE ${targets.job}`,
    );

    if (targets.verification) {
      // Better Auth keys verification rows by identifier with no user FK, so a
      // password-reset link would otherwise outlive the account that asked.
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM verification WHERE ${targets.verification}`,
      );
    }
  }

  private async resolveOwner(
    tx: Prisma.TransactionClient,
    studentId: string,
  ): Promise<StudentOwner | null> {
    const [owner] = await tx.$queryRaw<StudentOwner[]>`
      SELECT u.id AS "userId", u.email, u.phone, u."deactivatedAt",
             u."schoolId", s.status AS "schoolStatus"
      FROM student_profile sp
      JOIN "user" u ON u.id = sp."userId"
      LEFT JOIN school s ON s.id = u."schoolId"
      WHERE sp.id = ${studentId}::uuid`;
    return owner ?? null;
  }

  /**
   * The single surviving record that an erasure ran: counts and a scope, no
   * name, no contact detail, no content. Without it the school cannot answer
   * "was this student's deletion carried out?" once the request row itself has
   * cascaded away — and this row is the only thing that outlives an ALL_HISTORY
   * purge, which is exactly why it holds nothing about the person.
   */
  private async recordErasure(
    tx: Prisma.TransactionClient,
    row: DueRow,
    schoolId: string | null,
    removed: { checkIns: number; conversations: number },
    erasedAccount: boolean,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: 'history_deletion.executed',
        entity: 'HistoryDeletionRequest',
        entityId: row.id,
        schoolId,
        meta: {
          scope: row.scope,
          erasedAccount,
          removedCheckIns: removed.checkIns,
          removedConversations: removed.conversations,
          undoWindowMinutes: this.undoWindowMinutes,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    // A scoped erasure keeps its row and writes the outcome on it, so the
    // student's receipt can say what actually went. ALL_HISTORY has already
    // cascaded this row away — zero rows updated there is the expected path.
    await tx.$executeRaw(
      Prisma.sql`
        UPDATE history_deletion_request
        SET "purgedAt" = NOW(), "holdReason" = NULL,
            "removedCheckIns" = ${removed.checkIns},
            "removedConversations" = ${removed.conversations}
        WHERE id = ${row.id}::uuid`,
    );
  }

  /**
   * Post-transaction notice for a scoped erasure. Deliberately outside the
   * transaction and best-effort: a failed push must not roll back an erasure the
   * student asked for, and the receipt row already carries the counts.
   */
  private async announce(result: PurgeResult): Promise<void> {
    if (!result.notifyUserId) return;
    try {
      await this.notifications.pushMany({
        userIds: [result.notifyUserId],
        type: HISTORY_DELETION_EXECUTED_TYPE,
        title: 'What you asked to remove is removed',
        body: `As you asked, ${result.removedCheckIns} check-in(s) and ${result.removedConversations} conversation(s) have been removed from your history. Your account and everything else stayed.`,
        data: {
          scope: result.scope,
          removedCheckIns: result.removedCheckIns,
          removedConversations: result.removedConversations,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Erasure completed but the student was not told: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

interface PurgeResult {
  outcome: PurgeOutcome;
  erasedAccount: boolean;
  removedCheckIns: number;
  removedConversations: number;
  notifyUserId: string | null;
  scope: HistoryDeletionScope | null;
  holdCode?: string;
}

function noop(outcome: 'skipped' | 'executed' | 'held'): PurgeResult {
  return {
    outcome,
    erasedAccount: false,
    removedCheckIns: 0,
    removedConversations: 0,
    notifyUserId: null,
    scope: null,
  };
}

function holdCodeFor(owner: StudentOwner): string | null {
  if (owner.deactivatedAt) return 'ACCOUNT_INACTIVE';
  if (owner.schoolStatus === 'SUSPENDED') return 'SCHOOL_SUSPENDED';
  return null;
}

/**
 * The BEFORE_DATE boundary, as an instant. `beforeDate` is a DATE column — the
 * student named a day — and "everything before it" means before that day
 * begins, so the comparison is anchored to that midnight in UTC rather than to
 * whatever timezone the session happens to run in.
 */
function beforeDateScope(row: DueRow, studentId: string) {
  const day = new Date(row.beforeDate ?? 0).toISOString().slice(0, 10);
  // The whole instant is assembled in JS and bound as one value: a SQL
  // parameter cannot be concatenated with literal text, so `${day}T00:00:00Z`
  // inside the template would render as `$1T00:00:00Z` and fail to parse.
  const midnightUtc = `${day}T00:00:00Z`;
  const boundary = Prisma.sql`${midnightUtc}::timestamptz`;
  const owned = Prisma.sql`"studentId" = ${studentId}::uuid`;
  return {
    checkIns: Prisma.sql`${owned} AND "createdAt" < ${boundary}`,
    conversations: Prisma.sql`${owned} AND "createdAt" < ${boundary}`,
  };
}

/**
 * SELECTED_CHECK_INS. The entry and the reflection it produced are one item in
 * the student's own history view, so the ask removes both; the ids were already
 * validated as theirs when the ask was filed, and this filter re-checks
 * ownership because the ask may be months old.
 */
function selectedScope(row: DueRow, studentId: string) {
  const ids = [...new Set(row.checkInIds)];
  if (ids.length === 0) {
    return {
      checkIns: Prisma.sql`'1' = '2'`,
      conversations: Prisma.sql`'1' = '2'`,
    };
  }
  const list = Prisma.join(
    ids.map((id) => Prisma.sql`${id}::uuid`),
    ', ',
  );
  return {
    checkIns: Prisma.sql`"studentId" = ${studentId}::uuid AND id IN (${list})`,
    conversations: Prisma.sql`"studentId" = ${studentId}::uuid AND "checkInId" IN (${list})`,
  };
}

/** `SELECT id::text FROM <table> WHERE "studentId" = …` for one table. */
function idsOf(table: string, studentId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT id::text FROM ${Prisma.raw(table)}
    WHERE "studentId" = ${studentId}::uuid`;
}

/**
 * Every id that belonged to this student, including the ones that reach them
 * through a parent row rather than a `studentId` column. Used to delete the
 * audit rows that point at their objects.
 */
function ownedEntityIds(studentId: string, userId: string): Prisma.Sql {
  const sid = Prisma.sql`${studentId}::uuid`;
  return Prisma.join(
    [
      ...STUDENT_OWNED_TABLES.map(
        (table) => Prisma.sql`
          SELECT id::text FROM ${Prisma.raw(table)} WHERE "studentId" = ${sid}`,
      ),
      Prisma.sql`
        SELECT m.id::text FROM conversation_message m
        JOIN conversation c ON c.id = m."conversationId" WHERE c."studentId" = ${sid}`,
      Prisma.sql`
        SELECT a.id::text FROM ai_response_report a
        JOIN conversation_message m ON m.id = a."messageId"
        JOIN conversation c ON c.id = m."conversationId" WHERE c."studentId" = ${sid}`,
      Prisma.sql`
        SELECT cm.id::text FROM chat_message cm
        JOIN chat_thread t ON t.id = cm."threadId" WHERE t."studentId" = ${sid}`,
      Prisma.sql`
        SELECT j.id::text FROM ai_generation_job j
        WHERE j."input" ->> 'studentId' = ${studentId}`,
      Prisma.sql`SELECT id::text FROM "user" WHERE id = ${userId}::uuid`,
    ],
    ' UNION ',
  );
}

/**
 * How wide the unlinked-copy sweep reaches. Each fragment is the WHERE clause of
 * one DELETE, so the two builders below are the whole difference between "this
 * person is gone" and "these entries are gone".
 */
interface SweepTargets {
  audit: Prisma.Sql;
  notification: Prisma.Sql;
  job: Prisma.Sql;
  verification: Prisma.Sql | null;
}

/** Everything naming the student, because the student is leaving. */
function accountTargets(studentId: string, owner: StudentOwner): SweepTargets {
  return {
    audit: Prisma.sql`
      "actorId" = ${owner.userId}::uuid
      OR "meta" ->> 'studentId' = ${studentId}
      OR "meta" ->> 'checkInId' IN (${idsOf('emotional_check_in', studentId)})
      OR "meta" ->> 'conversationId' IN (${idsOf('conversation', studentId)})
      OR "entityId" IN (${ownedEntityIds(studentId, owner.userId)})`,
    notification: Prisma.sql`
      "userId" <> ${owner.userId}::uuid
      AND (
           "data" ->> 'studentId' = ${studentId}
        OR "data" ->> 'checkInId' IN (${idsOf('emotional_check_in', studentId)})
        OR "data" ->> 'conversationId' IN (${idsOf('conversation', studentId)})
        OR "data" ->> 'threadId' IN (${idsOf('chat_thread', studentId)})
        OR "data" ->> 'flagId' IN (${idsOf('support_flag', studentId)})
        OR "data" ->> 'requestId' IN (${idsOf('support_request', studentId)})
        OR "data" ->> 'requestId' IN (${idsOf('history_deletion_request', studentId)})
      )`,
    job: Prisma.sql`
      "input" ->> 'studentId' = ${studentId}
      OR "input" ->> 'conversationId' IN (${idsOf('conversation', studentId)})`,
    verification: Prisma.sql`
      "identifier" = ${owner.email}
      OR (${owner.phone}::text IS NOT NULL AND "identifier" = ${owner.phone})`,
  };
}

/**
 * Only what names the rows leaving. The student stays, so their own audit trail,
 * their identity rows and everything outside the scope are untouched.
 */
function scopeTargets(
  owner: StudentOwner,
  inScope: { checkIns: Prisma.Sql; conversations: Prisma.Sql },
): SweepTargets {
  // Bare `SELECT id::text` fragments; each use site adds its own parentheses so
  // the same fragment works both as a UNION arm and inside `IN (…)`.
  const checkIns = Prisma.sql`SELECT id::text FROM emotional_check_in WHERE ${inScope.checkIns}`;
  const conversations = Prisma.sql`SELECT id::text FROM conversation WHERE ${inScope.conversations}`;
  const messages = Prisma.sql`
    SELECT m.id::text FROM conversation_message m
    WHERE m."conversationId"::text IN (${conversations})`;
  const entityIds = Prisma.join(
    [
      checkIns,
      conversations,
      messages,
      Prisma.sql`
        SELECT a.id::text FROM ai_response_report a
        WHERE a."messageId"::text IN (${messages})`,
      Prisma.sql`
        SELECT s.id::text FROM session_summary s
        WHERE s."conversationId"::text IN (${conversations})`,
      Prisma.sql`
        SELECT f.id::text FROM check_in_feedback f
        WHERE f."checkInId"::text IN (${checkIns})`,
      Prisma.sql`
        SELECT an.id::text FROM check_in_answer an
        WHERE an."checkInId"::text IN (${checkIns})`,
      Prisma.sql`
        SELECT fs.id::text FROM check_in_feeling_selection fs
        WHERE fs."checkInId"::text IN (${checkIns})`,
    ],
    ' UNION ',
  );

  return {
    audit: Prisma.sql`
      "entityId" IN (${entityIds})
      OR "meta" ->> 'checkInId' IN (${checkIns})
      OR "meta" ->> 'conversationId' IN (${conversations})`,
    notification: Prisma.sql`
      "userId" <> ${owner.userId}::uuid
      AND (
           "data" ->> 'checkInId' IN (${checkIns})
        OR "data" ->> 'conversationId' IN (${conversations})
      )`,
    job: Prisma.sql`"input" ->> 'conversationId' IN (${conversations})`,
    verification: null,
  };
}
