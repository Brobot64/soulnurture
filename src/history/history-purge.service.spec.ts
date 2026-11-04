import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HistoryDeletionScope } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HistoryPurgeService } from './history-purge.service.js';

const STUDENT = '22d5780e-49e4-43fc-8737-743094ea9292';
const USER = '33d5780e-49e4-43fc-8737-743094ea9292';
const CHECK_IN = '44d5780e-49e4-43fc-8737-743094ea9292';

/**
 * The SQL itself is exercised against a real database by the journey harness;
 * these specs settle what a mock can: which rows are selected, in what order,
 * and what happens when the student cannot sign in.
 */
function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    studentId: STUDENT,
    scope: HistoryDeletionScope.ALL_HISTORY,
    beforeDate: null,
    checkInIds: [],
    ...overrides,
  };
}

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    email: 'jude@miva.edu.ng',
    phone: null,
    deactivatedAt: null,
    schoolId: 'school-1',
    schoolStatus: 'ACTIVE',
    ...overrides,
  };
}

const text = (sql: unknown, ...rest: unknown[]): string => {
  let base = '';
  let values: unknown[] = rest;
  if (typeof sql === 'string') base = sql;
  else if (Array.isArray(sql)) base = sql.join(' '); // tagged-template strings
  else {
    const s = sql as { sql?: string; values?: unknown[] };
    base = String(s.sql ?? '');
    values = Array.isArray(s.values) ? s.values : [];
  }
  // A bound value never appears in the statement text, so the asserts below can
  // only see the shape of the SQL unless the parameters are recorded with it.
  const flat = values
    .flatMap((v) => (v === null || v === undefined ? [] : [v]))
    .map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' ');
  return `${base.replace(/\s+/g, ' ').trim()} ${flat}`;
};

describe('HistoryPurgeService', () => {
  let service: HistoryPurgeService;
  let prisma: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let tx: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
    auditLog: { create: ReturnType<typeof vi.fn> };
  };
  let notifications: { pushMany: ReturnType<typeof vi.fn> };
  let statements: string[];
  let claim: unknown[];
  let owner: unknown[];

  beforeEach(async () => {
    statements = [];
    claim = [requestRow()];
    owner = [ownerRow()];

    tx = {
      $queryRaw: vi.fn((sql: unknown, ...rest: unknown[]) => {
        const t = text(sql, ...rest);
        statements.push(t);
        if (t.includes('FOR UPDATE SKIP LOCKED')) return Promise.resolve(claim);
        if (t.includes('FROM student_profile')) return Promise.resolve(owner);
        if (t.includes('count(*)'))
          return Promise.resolve([{ checkIns: 2, conversations: 3 }]);
        return Promise.resolve([]);
      }),
      $executeRaw: vi.fn((sql: unknown, ...rest: unknown[]) => {
        statements.push(text(sql, ...rest));
        return Promise.resolve(1);
      }),
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma = {
      $queryRaw: vi.fn((sql: unknown, ...rest: unknown[]) => {
        statements.push(text(sql, ...rest));
        return Promise.resolve([{ id: 'request-1' }]);
      }),
      $transaction: vi.fn((work: (client: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    notifications = { pushMany: vi.fn().mockResolvedValue([]) };

    const module = await Test.createTestingModule({
      providers: [
        HistoryPurgeService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue(undefined) } },
      ],
    }).compile();

    service = module.get(HistoryPurgeService);
  });

  const deletes = () =>
    statements
      .filter((s) => s.startsWith('DELETE'))
      .map((s) => s.split(' ')[2]);

  /** Re-reads the queue with a scoped ask instead of an account-wide one. */
  function askForScopedDeletion(overrides: Record<string, unknown>) {
    claim = [requestRow(overrides)];
    owner = [ownerRow()];
  }

  it('schedules an erasure one full window out, on the default 24 hours', () => {
    expect(service.scheduledPurgeAt(new Date('2026-11-04T10:00:00Z'))).toEqual(
      new Date('2026-11-05T10:00:00Z'),
    );
    expect(service.undoWindowMinutesValue).toBe(1440);
  });

  describe('purgeOne', () => {
    it('takes the row with a lock and a guard, so a cancel can win the race', async () => {
      await service.purgeOne('request-1');

      expect(statements[0]).toContain('FOR UPDATE SKIP LOCKED');
      expect(statements[0]).toContain('"purgedAt" IS NULL');
      expect(statements[0]).toContain('"cancelledAt" IS NULL');
    });

    it('does nothing when the row is already cancelled, purged or claimed', async () => {
      claim = [];

      expect(await service.purgeOne('request-1')).toBe('skipped');
      expect(deletes()).toHaveLength(0);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('closes an ask whose student is already gone instead of leaving it due', async () => {
      owner = [];

      expect(await service.purgeOne('request-1')).toBe('executed');
      expect(deletes()).toHaveLength(0);
      expect(
        statements.some((s) => s.includes('SET "purgedAt" = NOW(), "holdReason" = NULL')),
      ).toBe(true);
    });

    it('holds an account that cannot sign in rather than erase it unreachable', async () => {
      owner = [ownerRow({ deactivatedAt: new Date() })];

      expect(await service.purgeOne('request-1')).toBe('held');
      expect(deletes()).toHaveLength(0);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      const held = statements.find((s) => s.startsWith('UPDATE history_deletion_request'));
      expect(held).toContain('ACCOUNT_INACTIVE');
      // …and re-checked later, not left permanently due in the queue.
      expect(held).toContain("interval '1 minute'");
    });

    it('holds while the school is suspended', async () => {
      owner = [ownerRow({ schoolStatus: 'SUSPENDED' })];

      expect(await service.purgeOne('request-1')).toBe('held');
      expect(
        statements.find((s) => s.startsWith('UPDATE history_deletion_request')),
      ).toContain('SCHOOL_SUSPENDED');
    });
  });

  describe('ALL_HISTORY', () => {
    it('sweeps the copies a cascade cannot reach, then the profile, then the identity', async () => {
      expect(await service.purgeOne('request-1')).toBe('erased');

      expect(deletes()).toEqual([
        'audit_log',
        'notification',
        'ai_generation_job',
        'verification',
        'student_profile',
        '"user"',
      ]);
    });

    it('names the unlinked copies it removes', async () => {
      await service.purgeOne('request-1');

      const audit = statements.find((s) => s.startsWith('DELETE FROM audit_log'));
      expect(audit).toContain('"actorId" =');
      expect(audit).toContain("meta\" ->> 'studentId'");
      expect(audit).toContain('conversation_message');
      expect(audit).toContain('chat_message');

      const notif = statements.find((s) => s.startsWith('DELETE FROM notification'));
      expect(notif).toContain('"userId" <>');
      expect(notif).toContain("data\" ->> 'flagId'");
      expect(notif).toContain("data\" ->> 'threadId'");

      const jobs = statements.find((s) => s.startsWith('DELETE FROM ai_generation_job'));
      expect(jobs).toContain("input\" ->> 'studentId'");

      const verifications = statements.find((s) => s.startsWith('DELETE FROM verification'));
      expect(verifications).toContain('"identifier" =');
    });

    it('leaves one no-content audit row as the only surviving proof', async () => {
      await service.purgeOne('request-1');

      const audit = tx.auditLog.create.mock.calls[0][0].data;
      expect(audit.action).toBe('history_deletion.executed');
      expect(audit.entity).toBe('HistoryDeletionRequest');
      expect(audit.entityId).toBe('request-1');
      expect(audit.schoolId).toBe('school-1');
      expect(audit.meta).toMatchObject({
        scope: 'ALL_HISTORY',
        erasedAccount: true,
        removedCheckIns: 2,
        removedConversations: 3,
        undoWindowMinutes: 1440,
      });
      // Nothing about the person survives in the row that proves they left.
      expect(JSON.stringify(audit.meta)).not.toContain(STUDENT);
      expect(JSON.stringify(audit.meta)).not.toContain('jude@miva.edu.ng');
    });

    it('cannot notify a student who no longer exists', async () => {
      await service.purgeOne('request-1');

      expect(notifications.pushMany).not.toHaveBeenCalled();
    });
  });

  describe('a scoped erasure', () => {
    it('deletes conversations before the entries that point at them', async () => {
      askForScopedDeletion({
        scope: HistoryDeletionScope.SELECTED_CHECK_INS,
        checkInIds: [CHECK_IN],
      });

      expect(await service.purgeOne('request-1')).toBe('executed');
      expect(deletes()).toEqual([
        'audit_log',
        'notification',
        'ai_generation_job',
        'conversation',
        'emotional_check_in',
      ]);
      // …then repairs the dangling reference chat_thread holds without a FK.
      expect(
        statements.filter((s) => s.startsWith('UPDATE chat_thread')).length,
      ).toBe(1);
    });

    it('repairs the check-in reference and honours the day the student named', async () => {
      askForScopedDeletion({
        scope: HistoryDeletionScope.BEFORE_DATE,
        beforeDate: new Date('2026-10-01T00:00:00.000Z'),
      });

      await service.purgeOne('request-1');

      const repair = statements.find((s) => s.startsWith('UPDATE chat_thread'));
      expect(repair).toContain('"entryCheckInId" = NULL');
      expect(repair).toContain('"aiEntrySummary" = NULL');
      expect(repair).toContain('NOT EXISTS');

      const gone = statements.filter(
        (s) =>
          s.startsWith('DELETE FROM emotional_check_in') ||
          s.startsWith('DELETE FROM conversation'),
      );
      expect(gone).toHaveLength(2);
      // "Before that day" is anchored to its UTC midnight, not the session's zone.
      for (const statement of gone) {
        expect(statement).toContain('::timestamptz');
        expect(statement).toContain('2026-10-01T00:00:00Z');
      }
    });

    it('never reaches for the identity tables it has no warrant to touch', async () => {
      askForScopedDeletion({
        scope: HistoryDeletionScope.SELECTED_CHECK_INS,
        checkInIds: [CHECK_IN],
      });

      await service.purgeOne('request-1');

      expect(deletes()).not.toContain('student_profile');
      expect(deletes()).not.toContain('"user"');
      expect(deletes()).not.toContain('verification');
      // The student stays, so their own audit trail stays: no actor-wide sweep.
      expect(
        statements.find((s) => s.startsWith('DELETE FROM audit_log')),
      ).not.toContain('"actorId" =');
    });

    it('tells the student what went, outside the transaction', async () => {
      askForScopedDeletion({
        scope: HistoryDeletionScope.SELECTED_CHECK_INS,
        checkInIds: [CHECK_IN],
      });

      await service.purgeOne('request-1');

      expect(notifications.pushMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userIds: [USER],
          type: 'HISTORY_DELETION_EXECUTED',
        }),
      );
      expect(notifications.pushMany.mock.calls[0][0].body).toContain(
        '2 check-in(s) and 3 conversation(s)',
      );
    });

    it('still counts the erasure as done when that push fails', async () => {
      askForScopedDeletion({
        scope: HistoryDeletionScope.SELECTED_CHECK_INS,
        checkInIds: [CHECK_IN],
      });
      notifications.pushMany.mockRejectedValue(new Error('socket down'));

      expect(await service.purgeOne('request-1')).toBe('executed');
    });
  });

  describe('scanOnce', () => {
    it('selects only asks that were scheduled and are still owed', async () => {
      prisma.$queryRaw.mockImplementation((sql: unknown, ...rest: unknown[]) => {
        statements.push(text(sql, ...rest));
        return Promise.resolve([]);
      });

      await service.scanOnce();

      expect(statements[0]).toContain('"purgedAt" IS NULL');
      expect(statements[0]).toContain('"cancelledAt" IS NULL');
      expect(statements[0]).toContain('"scheduledPurgeAt" IS NOT NULL');
      expect(statements[0]).toContain('"scheduledPurgeAt" <= NOW()');
    });

    it('leaves an unscheduled legacy ask alone — no erasure it was never promised', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      expect(await service.scanOnce()).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('counts what it did', async () => {
      expect(await service.scanOnce()).toBe(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('never runs two passes at once', async () => {
      prisma.$queryRaw.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 20)),
      );

      const first = service.scanOnce();
      expect(await service.scanOnce()).toBe(0);
      await first;
    });

    it('keeps running when the queue read throws', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('table missing'));

      await expect(service.scanOnce()).resolves.toBe(0);
    });

    it('rolls back to a retry instead of reporting a partial erasure', async () => {
      prisma.$transaction.mockRejectedValue(new Error('deadlock detected'));

      expect(await service.purgeOne('request-1')).toBe('skipped');
      expect(notifications.pushMany).not.toHaveBeenCalled();
    });
  });
});
