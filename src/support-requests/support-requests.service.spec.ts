import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupportRequestStatus, SupportTiming } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ChatService } from '../chat/chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { SupportRequestsService } from './support-requests.service.js';

describe('SupportRequestsService', () => {
  let service: SupportRequestsService;
  let prisma: {
    supportPerson: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let chat: { openDirectThread: ReturnType<typeof vi.fn> };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    prisma = {
      supportPerson: { findMany: vi.fn(), findFirst: vi.fn() },
      supportRequest: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      user: { findUnique: vi.fn() },
      supportFlag: { findMany: vi.fn() },
    };
    audit = { log: vi.fn() };
    chat = { openDirectThread: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportRequestsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
        { provide: AuditService, useValue: audit },
        { provide: ChatService, useValue: chat },
      ],
    }).compile();

    service = module.get(SupportRequestsService);
  });

  it('lists only active support people', async () => {
    prisma.supportPerson.findMany.mockResolvedValue([
      { id: 'p1', name: 'Mrs. Adebayo', active: true },
    ]);
    const result = await service.listPeople();
    expect(prisma.supportPerson.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('throws NotFoundException when the support person is not available', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue(null);
    await expect(
      service.create('user-1', {
        supportPersonId: 'p1',
        personType: 'COUNSELLOR',
        timing: SupportTiming.GENTLE_1_2_DAYS,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('escalates an urgent/unsafe request and audits it', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue({ id: 'p1', active: true });
    prisma.supportRequest.create.mockResolvedValue({
      id: 'req-1',
      studentId: student.id,
      supportPerson: { id: 'p1' },
      status: SupportRequestStatus.ESCALATED,
    });

    const result = await service.create('user-1', {
      supportPersonId: 'p1',
      personType: 'COUNSELLOR',
      timing: SupportTiming.URGENT_UNSAFE,
      note: 'I am not safe',
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: SupportRequestStatus.ESCALATED }),
      include: { supportPerson: true },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_request.created' }),
    );
    expect(result.status).toBe(SupportRequestStatus.ESCALATED);
  });

  it('creates a gentle request as PENDING', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue({ id: 'p1', active: true });
    prisma.supportRequest.create.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.PENDING,
    });

    await service.create('user-1', {
      supportPersonId: 'p1',
      personType: 'TRUSTED_TEACHER',
      timing: SupportTiming.GENTLE_1_2_DAYS,
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: SupportRequestStatus.PENDING }),
      include: { supportPerson: true },
    });
  });

  it('forbids reading another students request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      studentId: 'student-2',
      supportPerson: { id: 'p1' },
    });
    await expect(service.getOne('user-1', 'req-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws NotFoundException for a missing request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue(null);
    await expect(service.getOne('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('professional review sets status plus review note and audits the change', async () => {
    prisma.supportRequest.findUnique
      .mockResolvedValueOnce({ id: 'req-1', status: 'PENDING', reviewNote: null })
      .mockResolvedValueOnce({ id: 'req-1', status: 'PENDING', reviewNote: null });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Seen this afternoon',
      supportPerson: { id: 'p1' },
    });

    const result = await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Seen this afternoon',
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: {
        status: SupportRequestStatus.ACCEPTED,
        reviewNote: 'Seen this afternoon',
      },
      include: { supportPerson: true },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_request.status_changed',
        entityId: 'req-1',
      }),
    );
    expect(result.status).toBe(SupportRequestStatus.ACCEPTED);
  });

  it('opens a chat with the student when the review accepts the request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: null,
      studentId: 'student-1',
      note: 'I would like to talk about exam stress',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: null,
      supportPerson: { id: 'p1' },
    });
    prisma.user.findUnique.mockResolvedValue({
      schoolId: 'school-1',
      name: 'Mrs. Adebayo',
    });
    chat.openDirectThread.mockResolvedValue({ id: 'thread-9', created: true });

    const result = await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.ACCEPTED,
    });

    expect(chat.openDirectThread).toHaveBeenCalledWith(
      'staff-1',
      expect.objectContaining({
        studentProfileId: 'student-1',
        schoolId: 'school-1',
      }),
    );
    expect(chat.openDirectThread.mock.calls[0][1].summary).toContain(
      'accepted your request to talk',
    );
    expect(chat.openDirectThread.mock.calls[0][1].summary).toContain(
      'I would like to talk about exam stress',
    );
    expect(result.chatThreadId).toBe('thread-9');
  });

  it('does not open a chat for non-accept review statuses', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: 'called yesterday',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'SCHEDULED',
      reviewNote: 'called yesterday',
    });

    const result = await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.SCHEDULED,
    });

    expect(chat.openDirectThread).not.toHaveBeenCalled();
    expect(result.chatThreadId).toBeNull();
  });

  it('keeps the existing review note when the PATCH omits one', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: 'called yesterday',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'SCHEDULED',
      reviewNote: 'called yesterday',
    });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.SCHEDULED,
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: SupportRequestStatus.SCHEDULED,
          reviewNote: 'called yesterday',
        },
      }),
    );
  });

  it('throws for reviewing a missing request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.review('staff-1', 'missing', { status: SupportRequestStatus.ACCEPTED }),
    ).rejects.toThrow(NotFoundException);
  });

  describe('listQueue (staff review queue)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    function queueRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'req-1',
        createdAt: new Date('2026-10-10T09:00:00Z'),
        timing: SupportTiming.GENTLE_1_2_DAYS,
        note: null,
        reviewNote: null,
        status: SupportRequestStatus.PENDING,
        conversationId: null,
        followUps: [],
        supportPerson: { id: 'p1', name: 'Mrs. Adebayo', type: 'COUNSELLOR' },
        student: {
          firstName: 'Amara',
          lastName: 'Nwosu',
          displayName: null,
          classLabel: 'Year 10',
          studentCode: 'GSS/2026/0142',
          studentRef: null,
          user: { email: 'amara@school.edu.ng' },
        },
        ...overrides,
      };
    }

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-1' });
      prisma.supportFlag.findMany.mockResolvedValue([]);
    });

    it('returns an empty queue for a staff user with no school', async () => {
      prisma.user.findUnique.mockResolvedValue({ schoolId: null });

      const result = await service.listQueue('staff-1', {});

      expect(result).toEqual({
        items: [],
        counts: {
          all: 0,
          new: 0,
          reviewed: 0,
          followUpRequired: 0,
          followUpCompleted: 0,
        },
      });
      expect(prisma.supportRequest.findMany).not.toHaveBeenCalled();
    });

    it('scopes the query to the school and excludes cancelled requests', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([]);

      await service.listQueue('staff-1', {});

      expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { not: SupportRequestStatus.CANCELLED },
            student: { user: { schoolId: 'school-1' } },
          },
        }),
      );
    });

    it('maps pending and escalated requests without follow-ups to NEW', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ id: 'req-1', status: SupportRequestStatus.PENDING }),
        queueRow({ id: 'req-2', status: SupportRequestStatus.ESCALATED }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items.map((item) => item.queueStatus)).toEqual([
        'NEW',
        'NEW',
      ]);
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 2, new: 2, reviewed: 0 }),
      );
    });

    it('maps accepted/scheduled/in-progress/completed requests to REVIEWED', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ id: 'a', status: SupportRequestStatus.ACCEPTED }),
        queueRow({ id: 'b', status: SupportRequestStatus.SCHEDULED }),
        queueRow({ id: 'c', status: SupportRequestStatus.IN_PROGRESS }),
        queueRow({ id: 'd', status: SupportRequestStatus.COMPLETED }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items.every((item) => item.queueStatus === 'REVIEWED')).toBe(
        true,
      );
      expect(result.counts.reviewed).toBe(4);
    });

    it('derives FOLLOW_UP_REQUIRED from an open follow-up and surfaces its due date', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          status: SupportRequestStatus.ACCEPTED,
          followUps: [
            {
              status: 'SCHEDULED',
              dueAt: new Date('2026-10-12T12:00:00Z'),
              completedAt: null,
            },
          ],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0].queueStatus).toBe('FOLLOW_UP_REQUIRED');
      expect(result.items[0].followUpDueAt).toEqual(
        new Date('2026-10-12T12:00:00Z'),
      );
      expect(result.counts.followUpRequired).toBe(1);
    });

    it('a completed follow-up wins over an open one and over the request status', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          status: SupportRequestStatus.PENDING,
          followUps: [
            {
              status: 'COMPLETED',
              dueAt: null,
              completedAt: new Date(Date.now() - DAY),
            },
            { status: 'PENDING', dueAt: null, completedAt: null },
          ],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0].queueStatus).toBe('FOLLOW_UP_COMPLETED');
      expect(result.counts).toEqual(
        expect.objectContaining({ new: 0, followUpCompleted: 1 }),
      );
    });

    it('counts completed-this-week only for follow-ups completed within 7 days', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          id: 'recent',
          followUps: [
            {
              status: 'COMPLETED',
              dueAt: null,
              completedAt: new Date(Date.now() - 2 * DAY),
            },
          ],
        }),
        queueRow({
          id: 'stale',
          followUps: [
            {
              status: 'COMPLETED',
              dueAt: null,
              completedAt: new Date(Date.now() - 10 * DAY),
            },
          ],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.counts.followUpCompleted).toBe(1);
    });

    it('flags the prompt as REVIEW_SUGGESTED for an active flag on the conversation', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ id: 'flagged', conversationId: 'conv-1' }),
        queueRow({ id: 'clean', conversationId: 'conv-2' }),
      ]);
      prisma.supportFlag.findMany.mockResolvedValue([
        { conversationId: 'conv-1', status: 'OPEN' },
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items.find((i) => i.id === 'flagged')?.prompt).toBe(
        'REVIEW_SUGGESTED',
      );
      expect(result.items.find((i) => i.id === 'clean')?.prompt).toBe('NONE');
    });

    it('carries the linked conversationId on the row for the deep link', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ id: 'req-linked', conversationId: 'conv-9' }),
        queueRow({ id: 'req-plain', conversationId: null }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items.find((i) => i.id === 'req-linked')?.conversationId).toBe(
        'conv-9',
      );
      expect(result.items.find((i) => i.id === 'req-plain')?.conversationId).toBeNull();
    });

    it('treats acknowledged flags as no prompt and skips the flag query without conversations', async () => {
      prisma.supportFlag.findMany.mockResolvedValue([
        { conversationId: 'conv-1', status: 'ACKNOWLEDGED' },
      ]);
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ conversationId: 'conv-1' }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0].prompt).toBe('NONE');

      prisma.supportFlag.findMany.mockClear();
      prisma.supportRequest.findMany.mockResolvedValue([queueRow()]);
      await service.listQueue('staff-1', {});
      expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    });

    it('applies the status filter to items but never to the chip counts', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({ id: 'req-new', status: SupportRequestStatus.PENDING }),
        queueRow({ id: 'req-reviewed', status: SupportRequestStatus.ACCEPTED }),
      ]);

      const result = await service.listQueue('staff-1', { status: 'NEW' });

      expect(result.items.map((item) => item.id)).toEqual(['req-new']);
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 2, new: 1, reviewed: 1 }),
      );
    });

    it('narrows rows by student code, ref or email search but never the chip counts', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          id: 'req-hit',
          student: {
            user: { email: 'amara@school.test' },
            firstName: 'Amara',
            lastName: 'N',
            displayName: null,
            classLabel: 'Year 10',
            studentRef: null,
            studentCode: 'GSS/2026/0142',
          },
        }),
        queueRow({
          id: 'req-miss',
          student: {
            user: { email: 'jude@school.test' },
            firstName: 'Jude',
            lastName: 'O',
            displayName: null,
            classLabel: 'Year 10',
            studentRef: null,
            studentCode: 'GSS/2026/0999',
          },
        }),
      ]);

      const result = await service.listQueue('staff-1', { q: 'amara@school' });

      expect(result.items.map((item) => item.id)).toEqual(['req-hit']);
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 2, new: 2 }),
      );
    });
  });
});