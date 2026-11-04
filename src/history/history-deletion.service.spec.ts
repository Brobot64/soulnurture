import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { HistoryDeletionScope } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { HistoryDeletionService } from './history-deletion.service.js';
import { HistoryPurgeService } from './history-purge.service.js';

const student = { id: 'student-1', userId: 'user-1' };
const profileWithSchool = {
  studentRef: 'MIVA/2026/0142',
  displayName: 'Jude',
  firstName: 'Jude',
  user: { schoolId: 'school-1' },
};

/** The real worker's window, so the assertions are about the schedule this
 * service hands to the student, not about a stub's arithmetic. */
const purgeStub = { scheduledPurgeAt: (from = new Date()) => new Date(from.getTime() + 24 * 60 * 60 * 1000) };

describe('HistoryDeletionService', () => {
  let service: HistoryDeletionService;
  let prisma: {
    historyDeletionRequest: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    emotionalCheckIn: { findMany: ReturnType<typeof vi.fn> };
    studentProfile: { findUnique: ReturnType<typeof vi.fn> };
    user: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let notifications: { pushMany: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      historyDeletionRequest: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
      emotionalCheckIn: { findMany: vi.fn().mockResolvedValue([]) },
      studentProfile: { findUnique: vi.fn().mockResolvedValue(profileWithSchool) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'reviewer-1' }]), findUnique: vi.fn().mockResolvedValue({ schoolId: 'school-1' }) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'request-1' }]),
    };
    notifications = { pushMany: vi.fn().mockResolvedValue([]) };
    audit = { log: vi.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: StudentsService, useValue: { ensureProfile: vi.fn().mockResolvedValue(student) } },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: audit },
        { provide: HistoryPurgeService, useValue: purgeStub },
      ],
    }).compile();

    service = module.get(HistoryDeletionService);
    prisma.historyDeletionRequest.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'request-1', alertedAt: null, cancelledAt: null, purgedAt: null, holdReason: null, removedCheckIns: 0, removedConversations: 0, createdAt: new Date('2026-11-04T10:00:00Z'), ...data }),
    );
    prisma.historyDeletionRequest.update.mockResolvedValue({});
    prisma.historyDeletionRequest.findUnique.mockResolvedValue({
      id: 'request-1',
      scope: HistoryDeletionScope.ALL_HISTORY,
      cancelledAt: new Date('2026-11-04T11:00:00Z'),
      scheduledPurgeAt: new Date('2026-11-05T10:00:00Z'),
      purgedAt: null,
    });
  });

  it('stores an ALL_HISTORY ask and removes nothing', async () => {
    const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });

    expect(prisma.historyDeletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          studentId: student.id,
          scope: HistoryDeletionScope.ALL_HISTORY,
          beforeDate: null,
          checkInIds: [],
        }),
      }),
    );
    expect(receipt.scope).toBe(HistoryDeletionScope.ALL_HISTORY);
    // The whole contract of this slice: the request table is the only thing
    // written. The harness exposes no delete/deleteMany on any table, so a
    // removal attempt here would throw rather than pass quietly.
    expect(prisma.historyDeletionRequest.update).toHaveBeenCalledTimes(1);
  });

  it('schedules the erasure 24 hours out, so the window is a fact on the row', async () => {
    const before = Date.now();
    const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });
    const scheduled = receipt.scheduledPurgeAt as Date;

    expect(scheduled).toBeInstanceOf(Date);
    expect(scheduled.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000 - 1000,
    );
    expect(scheduled.getTime()).toBeLessThan(
      Date.now() + 24 * 60 * 60 * 1000 + 5000,
    );
  });

  it('records the student’s own words as the note, trimmed, or null', async () => {
    await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY, note: '  these weeks were hard  ' });

    expect(prisma.historyDeletionRequest.create.mock.calls[0][0].data.note).toBe(
      'these weeks were hard',
    );

    await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY, note: '   ' });
    expect(prisma.historyDeletionRequest.create.mock.calls[1][0].data.note).toBeNull();
  });

  describe('scope/field pairing', () => {
    it('refuses a date on an ALL_HISTORY ask instead of half-honouring it', async () => {
      await expect(
        service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY, beforeDate: '2026-10-01' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.historyDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('requires the date for BEFORE_DATE', async () => {
      await expect(
        service.create(student.userId, { scope: HistoryDeletionScope.BEFORE_DATE }),
      ).rejects.toThrow(BadRequestException);
    });

    it('keeps the date for BEFORE_DATE and refuses stray ids', async () => {
      await service.create(student.userId, { scope: HistoryDeletionScope.BEFORE_DATE, beforeDate: '2026-10-01' });

      expect(prisma.historyDeletionRequest.create.mock.calls[0][0].data).toMatchObject({
        scope: HistoryDeletionScope.BEFORE_DATE,
        checkInIds: [],
      });
      expect(prisma.historyDeletionRequest.create.mock.calls[0][0].data.beforeDate).toBeInstanceOf(Date);

      await expect(
        service.create(student.userId, {
          scope: HistoryDeletionScope.BEFORE_DATE,
          beforeDate: '2026-10-01',
          checkInIds: ['22d5780e-49e4-43fc-8737-743094ea9292'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires at least one selected check-in', async () => {
      await expect(
        service.create(student.userId, { scope: HistoryDeletionScope.SELECTED_CHECK_INS, checkInIds: [] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('ownership of selected check-ins', () => {
    const mine = '22d5780e-49e4-43fc-8737-743094ea9292';
    const notMine = '33d5780e-49e4-43fc-8737-743094ea9292';

    it('refuses an ask that names a check-in the student does not own', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([{ id: mine }]);

      await expect(
        service.create(student.userId, {
          scope: HistoryDeletionScope.SELECTED_CHECK_INS,
          checkInIds: [mine, notMine],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.historyDeletionRequest.create).not.toHaveBeenCalled();
    });

    it('freezes the ids as asked and lists them once', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([{ id: mine }]);

      await service.create(student.userId, {
        scope: HistoryDeletionScope.SELECTED_CHECK_INS,
        checkInIds: [mine, mine],
      });

      expect(prisma.historyDeletionRequest.create.mock.calls[0][0].data.checkInIds).toEqual([mine]);
    });
  });

  describe('telling a person', () => {
    it('notifies the school’s professionals and stamps the receipt', async () => {
      const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });

      expect(notifications.pushMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userIds: ['reviewer-1'],
          type: 'HISTORY_DELETION_REQUEST',
        }),
      );
      const body = notifications.pushMany.mock.calls[0][0].body;
      expect(body).toContain('MIVA/2026/0142');
      expect(body).toContain('their entire history');
      expect(body).toContain('Nothing has been removed yet');
      // The owner's ruling turned staff from deciders into informed parties, so
      // the notice must not read as a task assigned to them.
      expect(body).toContain('This is their decision, not one you are being asked to make');
      expect(body).not.toContain('tell the student the outcome');
      expect(notifications.pushMany.mock.calls[0][0].data.scheduledPurgeAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
      );
      expect(receipt.alertedAt).toBeInstanceOf(Date);
    });

    it('keeps the ask and leaves the receipt un-stamped when the school has nobody to tell', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });

      expect(prisma.historyDeletionRequest.create).toHaveBeenCalledTimes(1);
      expect(notifications.pushMany).not.toHaveBeenCalled();
      expect(receipt.alertedAt).toBeNull();
    });

    it('keeps the ask when the notification itself fails — an alert outage never loses a request', async () => {
      notifications.pushMany.mockRejectedValue(new Error('socket down'));

      const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });

      expect(prisma.historyDeletionRequest.create).toHaveBeenCalledTimes(1);
      expect(receipt.alertedAt).toBeNull();
    });

    it('keeps the ask un-notified for a student with no school', async () => {
      prisma.studentProfile.findUnique.mockResolvedValue({ ...profileWithSchool, user: { schoolId: null } });

      const receipt = await service.create(student.userId, { scope: HistoryDeletionScope.ALL_HISTORY });

      expect(receipt.alertedAt).toBeNull();
      expect(notifications.pushMany).not.toHaveBeenCalled();
    });
  });

  describe('cancelling inside the window', () => {
    it('stops a scheduled erasure with one guarded statement, then records it', async () => {
      const row = await service.cancel(student.userId, 'request-1');

      // Called as a tagged template, so the first argument is the string parts.
      const sql = (prisma.$queryRaw.mock.calls[0][0] as unknown[]).join(' ');
      // Every condition of the undo in the UPDATE itself, so a cancel racing the
      // worker cannot both win.
      expect(sql).toContain('"studentId" =');
      expect(sql).toContain('"cancelledAt" IS NULL');
      expect(sql).toContain('"purgedAt" IS NULL');
      expect(sql).toContain('"scheduledPurgeAt" > NOW()');
      expect(row?.cancelledAt).toBeInstanceOf(Date);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'history_deletion.cancelled',
          entity: 'HistoryDeletionRequest',
          entityId: 'request-1',
          schoolId: 'school-1',
        }),
      );
    });

    it('says so when the removal has already happened', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.historyDeletionRequest.findFirst.mockResolvedValue({
        purgedAt: new Date(),
        cancelledAt: null,
        scheduledPurgeAt: new Date('2026-11-05T10:00:00Z'),
      });

      await expect(service.cancel(student.userId, 'request-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.cancel(student.userId, 'request-1')).rejects.toMatchObject({
        response: { code: 'ALREADY_REMOVED' },
      });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses a second cancel and a cancel after the window closed', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.historyDeletionRequest.findFirst.mockResolvedValue({
        purgedAt: null,
        cancelledAt: new Date(),
        scheduledPurgeAt: new Date('2026-11-05T10:00:00Z'),
      });
      await expect(service.cancel(student.userId, 'request-1')).rejects.toMatchObject({
        response: { code: 'ALREADY_CANCELLED' },
      });

      prisma.historyDeletionRequest.findFirst.mockResolvedValue({
        purgedAt: null,
        cancelledAt: null,
        scheduledPurgeAt: new Date('2026-11-03T10:00:00Z'),
      });
      await expect(service.cancel(student.userId, 'request-1')).rejects.toMatchObject({
        response: { code: 'WINDOW_CLOSED' },
      });
    });

    it('treats another student’s request id as not found', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.historyDeletionRequest.findFirst.mockResolvedValue(null);

      await expect(service.cancel(student.userId, 'request-9')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('lists only this student’s requests, newest first', async () => {
    prisma.historyDeletionRequest.findMany.mockResolvedValue([]);

    await service.listMine(student.userId);

    expect(prisma.historyDeletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } }),
    );
  });
});
