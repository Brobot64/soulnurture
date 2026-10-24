import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FollowUpStatus, SupportRequestStatus, SupportTiming } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ChatService } from '../chat/chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { deriveQueueStatus } from './queue-status.js';
import { SupportRequestsService } from './support-requests.service.js';

describe('deriveQueueStatus precedence', () => {
  it.each([FollowUpStatus.PENDING, FollowUpStatus.SCHEDULED])(
    '%s takes precedence over historical completion in either order',
    (status) => {
      for (const requestStatus of [SupportRequestStatus.PENDING, SupportRequestStatus.COMPLETED]) {
        for (const followUps of [
          [{ status: FollowUpStatus.COMPLETED }, { status }],
          [{ status }, { status: FollowUpStatus.COMPLETED }],
        ]) {
          expect(deriveQueueStatus({ status: requestStatus, followUps })).toBe('FOLLOW_UP_REQUIRED');
        }
      }
    },
  );

  it('keeps completed precedence when no follow-up is open', () => {
    expect(deriveQueueStatus({
      status: SupportRequestStatus.PENDING,
      followUps: [{ status: FollowUpStatus.COMPLETED }, { status: FollowUpStatus.CANCELLED }],
    })).toBe('FOLLOW_UP_COMPLETED');
  });

  it.each([
    { status: SupportRequestStatus.PENDING, expected: 'NEW' },
    { status: SupportRequestStatus.ESCALATED, expected: 'NEW' },
    { status: SupportRequestStatus.ACCEPTED, expected: 'REVIEWED' },
    { status: SupportRequestStatus.SCHEDULED, expected: 'REVIEWED' },
    { status: SupportRequestStatus.IN_PROGRESS, expected: 'REVIEWED' },
    { status: SupportRequestStatus.COMPLETED, expected: 'REVIEWED' },
  ])('ignores cancelled follow-ups for request $status', ({ status, expected }) => {
    expect(deriveQueueStatus({
      status, followUps: [{ status: FollowUpStatus.CANCELLED }],
    })).toBe(expected);
  });
});

describe('SupportRequestsService', () => {
  let service: SupportRequestsService;
  let prisma: {
    supportPerson: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
    conversation: Record<string, ReturnType<typeof vi.fn>>;
    conversationMessage: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let chat: { openDirectThread: ReturnType<typeof vi.fn> };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  const studentRequestSelect = {
    id: true,
    personType: true,
    timing: true,
    note: true,
    status: true,
    scheduledAt: true,
    locationLabel: true,
    createdAt: true,
    updatedAt: true,
    supportPerson: { select: { id: true, name: true, type: true, title: true } },
  };

  beforeEach(async () => {
    prisma = {
      supportPerson: { findMany: vi.fn(), findFirst: vi.fn() },
      supportRequest: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      user: { findUnique: vi.fn() },
      supportFlag: { findMany: vi.fn() },
      conversation: { findFirst: vi.fn() },
      conversationMessage: { findFirst: vi.fn() },
    };
    audit = { log: vi.fn() };
    chat = { openDirectThread: vi.fn() };

    // Staff mutations resolve their tenant from the actor's account.
    prisma.user.findUnique.mockResolvedValue({
      schoolId: 'school-1',
      name: 'Mrs. Adebayo',
    });

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

  const schoolContactScope = {
    active: true,
    professional: {
      user: {
        schoolId: 'school-1',
        deactivatedAt: null,
        role: { in: ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] },
      },
    },
  };

  it('lists only active contacts linked to professionals in the caller school', async () => {
    prisma.supportPerson.findMany.mockResolvedValue([
      { id: 'p1', name: 'Mrs. Adebayo' },
    ]);
    const result = await service.listPeople('user-1');
    expect(prisma.supportPerson.findMany).toHaveBeenCalledWith({
      where: schoolContactScope,
      select: {
        id: true, name: true, type: true, title: true,
        availabilityLabel: true, availableToday: true, imageUrl: true,
      },
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it.each([null, { schoolId: null }])('fails closed without a school (%j)', async (user) => {
    prisma.user.findUnique.mockResolvedValue(user);

    expect(await service.listPeople('user-1')).toEqual([]);
    await expect(service.create('user-1', {
      supportPersonId: 'p1', personType: 'COUNSELLOR', timing: SupportTiming.GENTLE_1_2_DAYS,
    })).rejects.toThrow(NotFoundException);

    expect(prisma.supportPerson.findMany).not.toHaveBeenCalled();
    expect(prisma.supportPerson.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportRequest.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each(['foreign-school', 'unlinked', 'deactivated', 'wrong-type'])(
    'rejects a %s contact without creating a request',
    async (supportPersonId) => {
      prisma.supportPerson.findFirst.mockResolvedValue(null);
      await expect(service.create('user-1', {
        supportPersonId, personType: 'COUNSELLOR', timing: SupportTiming.GENTLE_1_2_DAYS,
      })).rejects.toThrow(NotFoundException);
      expect(prisma.supportPerson.findFirst).toHaveBeenCalledWith({
        where: { id: supportPersonId, type: 'COUNSELLOR', ...schoolContactScope },
      });
      expect(prisma.supportRequest.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

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
      select: studentRequestSelect,
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
      select: studentRequestSelect,
    });
  });

  it('lists only student-visible fields without fetching private review or profile data', async () => {
    const items = [{ id: 'req-1', status: SupportRequestStatus.ACCEPTED }];
    prisma.supportRequest.findMany.mockResolvedValue(items);

    expect(await service.listMine('user-1')).toEqual({ items });
    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith({
      where: { studentId: 'student-1' },
      select: studentRequestSelect,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('reads an owned request using the same student-only field selection', async () => {
    const item = { id: 'req-1', status: SupportRequestStatus.ACCEPTED };
    prisma.supportRequest.findFirst.mockResolvedValue(item);

    expect(await service.getOne('user-1', 'req-1')).toEqual(item);
    expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'req-1', studentId: 'student-1' },
      select: studentRequestSelect,
    });
  });

  it.each(['missing', 'another-students-request'])(
    'returns not found for %s without disclosing ownership',
    async (id) => {
      prisma.supportRequest.findFirst.mockResolvedValue(null);

      await expect(service.getOne('user-1', id)).rejects.toThrow(NotFoundException);
      expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith({
        where: { id, studentId: 'student-1' },
        select: studentRequestSelect,
      });
    },
  );

  it('professional review sets status plus review note and audits the change', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: null,
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Seen this afternoon',
      supportPerson: { id: 'p1' },
    });
    chat.openDirectThread.mockResolvedValue({ id: 'thread-1', created: true });

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
    expect(result.reviewNote).toBe('Seen this afternoon');
  });

  it('opens a chat with the student when the review accepts the request', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
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
    prisma.supportRequest.findFirst.mockResolvedValue({
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
    prisma.supportRequest.findFirst.mockResolvedValue({
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
    prisma.supportRequest.findFirst.mockResolvedValue(null);
    await expect(
      service.review('staff-1', 'missing', { status: SupportRequestStatus.ACCEPTED }),
    ).rejects.toThrow(NotFoundException);
  });

  it("refuses to review another school's request, and never writes", async () => {
    // The lookup carries the tenant filter, so a foreign id resolves to
    // nothing and the row cannot be progressed by the wrong school.
    prisma.supportRequest.findFirst.mockResolvedValue(null);

    await expect(
      service.review('staff-1', 'other-school-req', {
        status: SupportRequestStatus.ACCEPTED,
        reviewNote: 'not mine',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'other-school-req',
        student: { user: { schoolId: 'school-1' } },
      },
    });
    expect(prisma.supportRequest.update).not.toHaveBeenCalled();
    expect(chat.openDirectThread).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses to review any request for a staff user with no school', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    await expect(
      service.review('orphan-1', 'req-1', {
        status: SupportRequestStatus.COMPLETED,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.supportRequest.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportRequest.update).not.toHaveBeenCalled();
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
          id: 'student-1',
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
          include: {
            followUps: {
              select: {
                id: true,
                status: true,
                dueAt: true,
                completedAt: true,
                professional: { select: { userId: true } },
              },
            },
            supportPerson: { select: { id: true, name: true, type: true } },
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                displayName: true,
                classLabel: true,
                studentCode: true,
                studentRef: true,
                user: { select: { email: true } },
              },
            },
          },
        }),
      );
    });

    it('retains private review notes and original message snapshots for the staff queue', async () => {
      const initialMessageAt = new Date('2026-10-10T08:55:00Z');
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          reviewNote: 'Private staff review',
          initialMessage: 'I would like help with exam stress',
          initialMessageAt,
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          reviewNote: 'Private staff review',
          initialMessage: 'I would like help with exam stress',
          initialMessageAt,
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

    it.each([
      { status: 'PENDING', professional: { userId: 'staff-1' }, canManage: true },
      { status: 'SCHEDULED', professional: { userId: 'staff-1' }, canManage: true },
      { status: 'PENDING', professional: null, canManage: false },
      { status: 'SCHEDULED', professional: { userId: 'other-staff' }, canManage: false },
    ])('surfaces open follow-up status and grants management only to its owner (%j)', async ({ status, professional, canManage }) => {
      const dueAt = new Date('2026-10-12T12:00:00Z');
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          status: SupportRequestStatus.ACCEPTED,
          followUps: [{ id: 'fu-1', status, dueAt, completedAt: null, professional }],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0]).toMatchObject({
        queueStatus: 'FOLLOW_UP_REQUIRED',
        followUpId: 'fu-1',
        followUpStatus: status,
        followUpDueAt: dueAt,
        canManageFollowUp: canManage,
      });
      expect(result.items[0].student).toEqual({
        id: 'student-1',
        firstName: 'Amara',
        lastName: 'Nwosu',
        displayName: null,
        classLabel: 'Year 10',
        studentCode: 'GSS/2026/0142',
        studentRef: null,
        email: 'amara@school.edu.ng',
      });
      expect(result.items[0]).not.toHaveProperty('professional');
      expect(result.items[0]).not.toHaveProperty('followUps');
      expect(result.counts.followUpRequired).toBe(1);
    });

    it.each([
      { selectedOwner: 'other-staff', laterOwner: 'staff-1', canManage: false },
      { selectedOwner: 'staff-1', laterOwner: 'other-staff', canManage: true },
    ])('bases all follow-up fields on the earliest open row, not another owned row (%j)', async ({ selectedOwner, laterOwner, canManage }) => {
      const dueAt = new Date('2026-10-12T12:00:00Z');
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          followUps: [
            { id: 'undated', status: 'PENDING', dueAt: null, completedAt: null, professional: { userId: laterOwner } },
            { id: 'later', status: 'PENDING', dueAt: new Date('2026-10-13T12:00:00Z'), completedAt: null, professional: { userId: laterOwner } },
            { id: 'closed', status: 'CANCELLED', dueAt: new Date('2026-10-11T12:00:00Z'), completedAt: null, professional: { userId: 'staff-1' } },
            { id: 'earliest', status: 'SCHEDULED', dueAt, completedAt: null, professional: { userId: selectedOwner } },
          ],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items[0]).toMatchObject({
        followUpId: 'earliest',
        followUpStatus: 'SCHEDULED',
        followUpDueAt: dueAt,
        canManageFollowUp: canManage,
      });
    });

    it.each([
      { statuses: [] },
      { statuses: ['COMPLETED'] },
      { statuses: ['CANCELLED'] },
      { statuses: ['COMPLETED', 'CANCELLED'] },
    ])(
      'returns null open-follow-up fields and no management when none are open (%j)',
      async ({ statuses }) => {
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            followUps: statuses.map((status) => ({
              id: `fu-${status}`, status, dueAt: null, completedAt: null,
              professional: { userId: 'staff-1' },
            })),
          }),
        ]);

        const result = await service.listQueue('staff-1', {});

        expect(result.items[0]).toMatchObject({
          followUpId: null, followUpStatus: null, followUpDueAt: null,
          canManageFollowUp: false,
        });
      },
    );

    it.each(['PENDING', 'SCHEDULED'])(
      'an open %s follow-up wins over historical completion and the request status',
      async (status) => {
        const completedAt = new Date(Date.now() - DAY);
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            status: SupportRequestStatus.PENDING,
            followUps: [
              { id: 'done', status: 'COMPLETED', dueAt: null, completedAt, professional: { userId: 'staff-1' } },
              { id: 'open', status, dueAt: null, completedAt: null, professional: null },
            ],
          }),
        ]);

        const result = await service.listQueue('staff-1', { status: 'FOLLOW_UP_REQUIRED' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
          queueStatus: 'FOLLOW_UP_REQUIRED', followUpId: 'open', followUpStatus: status,
          followUpCompletedAt: completedAt, canManageFollowUp: false,
        });
        expect(result.counts).toEqual({
          all: 1, new: 0, reviewed: 0, followUpRequired: 1, followUpCompleted: 0,
        });
      },
    );

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