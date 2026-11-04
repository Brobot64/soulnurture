import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { HistoryDeletionScope } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { HistoryDeletionService } from './history-deletion.service.js';

const student = { id: 'student-1', userId: 'user-1' };
const profileWithSchool = {
  studentRef: 'MIVA/2026/0142',
  displayName: 'Jude',
  firstName: 'Jude',
  user: { schoolId: 'school-1' },
};

describe('HistoryDeletionService', () => {
  let service: HistoryDeletionService;
  let prisma: {
    historyDeletionRequest: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    emotionalCheckIn: { findMany: ReturnType<typeof vi.fn> };
    studentProfile: { findUnique: ReturnType<typeof vi.fn> };
    user: { findMany: ReturnType<typeof vi.fn> };
  };
  let notifications: { pushMany: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      historyDeletionRequest: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      emotionalCheckIn: { findMany: vi.fn().mockResolvedValue([]) },
      studentProfile: { findUnique: vi.fn().mockResolvedValue(profileWithSchool) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'reviewer-1' }]) },
    };
    notifications = { pushMany: vi.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: StudentsService, useValue: { ensureProfile: vi.fn().mockResolvedValue(student) } },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(HistoryDeletionService);
    prisma.historyDeletionRequest.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'request-1', alertedAt: null, createdAt: new Date('2026-11-04T10:00:00Z'), ...data }),
    );
    prisma.historyDeletionRequest.update.mockResolvedValue({});
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
      expect(body).toContain('all of their history');
      expect(body).toContain('Nothing has been removed');
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

  it('lists only this student’s requests, newest first', async () => {
    prisma.historyDeletionRequest.findMany.mockResolvedValue([]);

    await service.listMine(student.userId);

    expect(prisma.historyDeletionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: student.id }, orderBy: { createdAt: 'desc' } }),
    );
  });
});
