import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { validate } from 'class-validator';
import {
  FollowUpStatus,
  SupportRequestStatus,
  SupportTiming,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ChatService } from '../chat/chat.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';
import {
  QUEUE_STATUSES,
  deriveFollowUpState,
  deriveQueueStatus,
  deriveUrgency,
  matchesQueueFilter,
  type QueueRow,
} from './queue-status.js';
import { SupportRequestsService } from './support-requests.service.js';

const OPEN = [FollowUpStatus.PENDING, FollowUpStatus.SCHEDULED] as const;

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    status: SupportRequestStatus.PENDING,
    timing: SupportTiming.GENTLE_1_2_DAYS,
    followUps: [],
    ...overrides,
  };
}

describe('deriveQueueStatus — has a professional acted yet?', () => {
  it.each([SupportRequestStatus.PENDING, SupportRequestStatus.ESCALATED])(
    '%s is NEW',
    (status) => {
      expect(deriveQueueStatus(row({ status }))).toBe('NEW');
    },
  );

  it.each([
    SupportRequestStatus.ACCEPTED,
    SupportRequestStatus.SCHEDULED,
    SupportRequestStatus.IN_PROGRESS,
    SupportRequestStatus.COMPLETED,
  ])('%s is REVIEWED', (status) => {
    expect(deriveQueueStatus(row({ status }))).toBe('REVIEWED');
  });

  it('is never overridden by a follow-up', () => {
    for (const status of OPEN) {
      expect(
        deriveQueueStatus(
          row({
            status: SupportRequestStatus.PENDING,
            followUps: [{ status }, { status: FollowUpStatus.COMPLETED }],
          }),
        ),
      ).toBe('NEW');
    }
  });

  it('stays REVIEWED once acted, whatever the follow-ups say', () => {
    for (const followUps of [
      [],
      [{ status: FollowUpStatus.COMPLETED }],
      [{ status: FollowUpStatus.SCHEDULED }],
    ]) {
      expect(
        deriveQueueStatus({
          status: SupportRequestStatus.COMPLETED,
          timing: SupportTiming.GENTLE_1_2_DAYS,
          followUps,
        }),
      ).toBe('REVIEWED');
    }
  });
});

describe('deriveFollowUpState', () => {
  it.each(OPEN)('%s is REQUIRED even beside an older completion', (status) => {
    for (const followUps of [
      [{ status: FollowUpStatus.COMPLETED }, { status }],
      [{ status }, { status: FollowUpStatus.COMPLETED }],
    ]) {
      expect(deriveFollowUpState(row({ followUps }))).toBe('REQUIRED');
    }
  });

  it('is COMPLETED once nothing is open', () => {
    expect(
      deriveFollowUpState(
        row({
          followUps: [
            { status: FollowUpStatus.COMPLETED },
            { status: FollowUpStatus.CANCELLED },
          ],
        }),
      ),
    ).toBe('COMPLETED');
  });

  it.each([[[]], [[{ status: FollowUpStatus.CANCELLED }]]])(
    'is NONE with nothing but %j',
    (followUps) => {
      expect(deriveFollowUpState(row({ followUps }))).toBe('NONE');
    },
  );
});

describe('deriveUrgency', () => {
  it('is URGENT when the student said they do not feel safe', () => {
    expect(deriveUrgency(row({ timing: SupportTiming.URGENT_UNSAFE }))).toBe(
      'URGENT',
    );
  });

  it('stays URGENT after a professional accepts it', () => {
    expect(
      deriveUrgency(
        row({
          status: SupportRequestStatus.ACCEPTED,
          timing: SupportTiming.URGENT_UNSAFE,
        }),
      ),
    ).toBe('URGENT');
  });

  it('is URGENT while the request sits escalated', () => {
    expect(deriveUrgency(row({ status: SupportRequestStatus.ESCALATED }))).toBe(
      'URGENT',
    );
  });

  it.each([SupportTiming.GENTLE_1_2_DAYS, SupportTiming.TODAY_STUDY_PERIOD])(
    '%s is NORMAL',
    (timing) => {
      expect(deriveUrgency(row({ timing }))).toBe('NORMAL');
    },
  );

  it('does not read urgency from the chip split', () => {
    const urgentButNew = row({ timing: SupportTiming.URGENT_UNSAFE });
    expect(deriveQueueStatus(urgentButNew)).toBe('NEW');
    expect(deriveUrgency(urgentButNew)).toBe('URGENT');
  });
});

describe('matchesQueueFilter', () => {
  it('is the single predicate behind every chip count', () => {
    const cases = [
      row({ status: SupportRequestStatus.PENDING }),
      row({ status: SupportRequestStatus.ACCEPTED }),
      row({
        status: SupportRequestStatus.ACCEPTED,
        followUps: [{ status: FollowUpStatus.SCHEDULED }],
      }),
      row({
        status: SupportRequestStatus.COMPLETED,
        followUps: [{ status: FollowUpStatus.COMPLETED }],
      }),
    ];
    for (const request of cases) {
      for (const filter of QUEUE_STATUSES) {
        const viaPredicate = matchesQueueFilter(request, filter);
        const viaParts =
          filter === 'FOLLOW_UP_REQUIRED'
            ? deriveFollowUpState(request) === 'REQUIRED'
            : filter === 'FOLLOW_UP_COMPLETED'
              ? deriveFollowUpState(request) === 'COMPLETED'
              : deriveQueueStatus(request) === filter;
        expect(viaPredicate).toBe(viaParts);
      }
    }
  });

  it('lets one row match two chips — the chips are filters, not a partition', () => {
    const request = row({
      status: SupportRequestStatus.PENDING,
      followUps: [{ status: FollowUpStatus.PENDING }],
    });
    expect(matchesQueueFilter(request, 'NEW')).toBe(true);
    expect(matchesQueueFilter(request, 'FOLLOW_UP_REQUIRED')).toBe(true);
    expect(matchesQueueFilter(request, 'REVIEWED')).toBe(false);
    expect(matchesQueueFilter(request, 'FOLLOW_UP_COMPLETED')).toBe(false);
  });
});

describe('ReviewSupportRequestDto schedule fields', () => {
  async function errors(input: Record<string, unknown>) {
    const dto = Object.assign(new ReviewSupportRequestDto(), input);
    return (await validate(dto)).map((error) => error.property);
  }

  it('demands a time and a place before a request can read as scheduled', async () => {
    expect(await errors({ status: SupportRequestStatus.SCHEDULED })).toEqual(
      expect.arrayContaining(['scheduledAt', 'locationLabel']),
    );
  });

  it('accepts a complete arrangement', async () => {
    expect(
      await errors({
        status: SupportRequestStatus.SCHEDULED,
        scheduledAt: '2026-11-04T10:30:00.000Z',
        locationLabel: 'Counselling office',
      }),
    ).toEqual([]);
  });

  it('does not force a schedule onto the other review statuses', async () => {
    expect(await errors({ status: SupportRequestStatus.ACCEPTED })).toEqual([]);
    expect(await errors({ status: SupportRequestStatus.COMPLETED })).toEqual(
      [],
    );
  });

  it('still rejects a malformed timestamp or blank location when supplied', async () => {
    expect(
      await errors({
        status: SupportRequestStatus.ACCEPTED,
        scheduledAt: 'next tuesday',
      }),
    ).toContain('scheduledAt');
    expect(
      await errors({
        status: SupportRequestStatus.IN_PROGRESS,
        locationLabel: '   ',
      }),
    ).toContain('locationLabel');
  });
});

describe('SupportRequestsService', () => {
  let service: SupportRequestsService;
  let prisma: {
    supportPerson: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
    studentProfile: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
    conversation: Record<string, ReturnType<typeof vi.fn>>;
    conversationMessage: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let chat: { openDirectThread: ReturnType<typeof vi.fn> };
  let notifications: { push: ReturnType<typeof vi.fn> };

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
    supportPerson: {
      select: { id: true, name: true, type: true, title: true },
    },
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
      studentProfile: { findUnique: vi.fn() },
      supportFlag: { findMany: vi.fn() },
      conversation: { findFirst: vi.fn() },
      conversationMessage: { findFirst: vi.fn() },
    };
    audit = { log: vi.fn() };
    chat = { openDirectThread: vi.fn() };
    notifications = { push: vi.fn() };

    // Staff mutations resolve their tenant from the actor's account.
    prisma.user.findUnique.mockResolvedValue({
      schoolId: 'school-1',
      name: 'Mrs. Adebayo',
    });
    // The student behind a request profile is who a status alert goes to.
    prisma.studentProfile.findUnique.mockResolvedValue({ userId: 'user-1' });

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
        { provide: NotificationsService, useValue: notifications },
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
        id: true,
        name: true,
        type: true,
        title: true,
        availabilityLabel: true,
        availableToday: true,
        imageUrl: true,
      },
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it.each([null, { schoolId: null }])(
    'fails closed without a school (%j)',
    async (user) => {
      prisma.user.findUnique.mockResolvedValue(user);

      expect(await service.listPeople('user-1')).toEqual([]);
      await expect(
        service.create('user-1', {
          supportPersonId: 'p1',
          personType: 'COUNSELLOR',
          timing: SupportTiming.GENTLE_1_2_DAYS,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.supportPerson.findMany).not.toHaveBeenCalled();
      expect(prisma.supportPerson.findFirst).not.toHaveBeenCalled();
      expect(prisma.supportRequest.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(['foreign-school', 'unlinked', 'deactivated', 'wrong-type'])(
    'rejects a %s contact without creating a request',
    async (supportPersonId) => {
      prisma.supportPerson.findFirst.mockResolvedValue(null);
      await expect(
        service.create('user-1', {
          supportPersonId,
          personType: 'COUNSELLOR',
          timing: SupportTiming.GENTLE_1_2_DAYS,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.supportPerson.findFirst).toHaveBeenCalledWith({
        where: {
          id: supportPersonId,
          type: 'COUNSELLOR',
          ...schoolContactScope,
        },
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
    prisma.supportPerson.findFirst.mockResolvedValue({
      id: 'p1',
      active: true,
    });
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
    prisma.supportPerson.findFirst.mockResolvedValue({
      id: 'p1',
      active: true,
    });
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

      await expect(service.getOne('user-1', id)).rejects.toThrow(
        NotFoundException,
      );
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

  it('writes the agreed time and place when a review schedules the request', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: null,
      studentId: 'student-1',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'SCHEDULED',
      reviewNote: null,
      scheduledAt: new Date('2026-11-04T10:30:00Z'),
      locationLabel: 'Counselling office, Block C',
      supportPerson: { id: 'p1', name: 'Mrs. Adebayo' },
    });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.SCHEDULED,
      scheduledAt: '2026-11-04T10:30:00.000Z',
      locationLabel: 'Counselling office, Block C',
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: SupportRequestStatus.SCHEDULED,
          reviewNote: null,
          scheduledAt: new Date('2026-11-04T10:30:00Z'),
          locationLabel: 'Counselling office, Block C',
        },
      }),
    );
  });

  it('leaves an existing arrangement alone for statuses that are not scheduling', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'SCHEDULED',
      reviewNote: null,
      scheduledAt: new Date('2026-11-04T10:30:00Z'),
      locationLabel: 'Counselling office, Block C',
      studentId: 'student-1',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'IN_PROGRESS',
      reviewNote: null,
      supportPerson: { id: 'p1', name: 'Mrs. Adebayo' },
    });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.IN_PROGRESS,
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: SupportRequestStatus.IN_PROGRESS, reviewNote: null },
      }),
    );
  });

  it('tells the student when the status actually changes, without the private note', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: null,
      studentId: 'student-1',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'ACCEPTED',
      reviewNote: 'Family situation — keep to myself',
      supportPerson: { id: 'p1', name: 'Mrs. Adebayo' },
    });
    chat.openDirectThread.mockResolvedValue({ id: 'thread-1', created: true });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Family situation — keep to myself',
    });

    expect(notifications.push).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        type: 'SUPPORT_REQUEST_STATUS',
        data: { requestId: 'req-1', status: SupportRequestStatus.ACCEPTED },
      }),
    );
    const [push] = notifications.push.mock.calls;
    expect(push[0].body).toContain('Mrs. Adebayo');
    expect(push[0].body).not.toContain('Family situation');
    expect(push[0].title).not.toContain('Family situation');
  });

  it.each([
    SupportRequestStatus.SCHEDULED,
    SupportRequestStatus.IN_PROGRESS,
    SupportRequestStatus.COMPLETED,
    SupportRequestStatus.CANCELLED,
  ])('announces a %s change in the student’s own words', async (status) => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: null,
      studentId: 'student-1',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status,
      reviewNote: null,
      supportPerson: { id: 'p1', name: 'Mrs. Adebayo' },
    });

    await service.review('staff-1', 'req-1', {
      status,
      ...(status === SupportRequestStatus.SCHEDULED
        ? { scheduledAt: '2026-11-04T10:30:00.000Z', locationLabel: 'Library' }
        : {}),
    });

    expect(notifications.push).toHaveBeenCalledTimes(1);
    expect(notifications.push.mock.calls[0][0].title).toMatch(/./);
  });

  it('stays silent when a save only corrects the note under the same status', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue({
      id: 'req-1',
      status: 'ACCEPTED',
      reviewNote: 'older note',
      studentId: 'student-1',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'ACCEPTED',
      reviewNote: 'corrected note',
      supportPerson: { id: 'p1', name: 'Mrs. Adebayo' },
    });

    chat.openDirectThread.mockResolvedValue({ id: 'thread-1', created: true });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'corrected note',
    });

    expect(notifications.push).not.toHaveBeenCalled();
  });

  it('throws for reviewing a missing request', async () => {
    prisma.supportRequest.findFirst.mockResolvedValue(null);
    await expect(
      service.review('staff-1', 'missing', {
        status: SupportRequestStatus.ACCEPTED,
      }),
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
          completedThisWeek: 0,
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

      // Escalated sorts ahead of the newer pending row: urgency outranks time.
      expect(result.items.map((item) => item.id)).toEqual(['req-2', 'req-1']);
      expect(result.items.map((item) => item.queueStatus)).toEqual([
        'NEW',
        'NEW',
      ]);
      expect(result.items.map((item) => item.urgency)).toEqual([
        'URGENT',
        'NORMAL',
      ]);
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 2, new: 2, reviewed: 0 }),
      );
    });

    it('maps accepted/scheduled/in-progress/completed requests to REVIEWED', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          id: 'a',
          status: SupportRequestStatus.ACCEPTED,
          createdAt: new Date('2026-10-07T09:00:00Z'),
        }),
        queueRow({
          id: 'b',
          status: SupportRequestStatus.SCHEDULED,
          createdAt: new Date('2026-10-08T09:00:00Z'),
        }),
        queueRow({
          id: 'c',
          status: SupportRequestStatus.IN_PROGRESS,
          createdAt: new Date('2026-10-09T09:00:00Z'),
        }),
        queueRow({
          id: 'd',
          status: SupportRequestStatus.COMPLETED,
          createdAt: new Date('2026-10-10T09:00:00Z'),
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(
        result.items.every((item) => item.queueStatus === 'REVIEWED'),
      ).toBe(true);
      // The coarse chip split must not erase the lifecycle: each row still
      // reports which of the four states it is actually in.
      expect(result.items.map((item) => item.requestStatus)).toEqual([
        SupportRequestStatus.COMPLETED,
        SupportRequestStatus.IN_PROGRESS,
        SupportRequestStatus.SCHEDULED,
        SupportRequestStatus.ACCEPTED,
      ]);
      expect(result.counts.reviewed).toBe(4);
    });

    it('sorts urgent rows first, then newest', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          id: 'gentle',
          createdAt: new Date('2026-10-12T09:00:00Z'),
          timing: SupportTiming.GENTLE_1_2_DAYS,
        }),
        queueRow({
          id: 'unsafe',
          createdAt: new Date('2026-10-01T09:00:00Z'),
          timing: SupportTiming.URGENT_UNSAFE,
        }),
        queueRow({
          id: 'today',
          createdAt: new Date('2026-10-11T09:00:00Z'),
          timing: SupportTiming.TODAY_STUDY_PERIOD,
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      expect(result.items.map((item) => [item.id, item.urgency])).toEqual([
        ['unsafe', 'URGENT'],
        ['gentle', 'NORMAL'],
        ['today', 'NORMAL'],
      ]);
    });

    it.each([
      {
        status: 'PENDING',
        professional: { userId: 'staff-1' },
        canManage: true,
      },
      {
        status: 'SCHEDULED',
        professional: { userId: 'staff-1' },
        canManage: true,
      },
      { status: 'PENDING', professional: null, canManage: false },
      {
        status: 'SCHEDULED',
        professional: { userId: 'other-staff' },
        canManage: false,
      },
    ])(
      'surfaces open follow-up status and grants management only to its owner (%j)',
      async ({ status, professional, canManage }) => {
        const dueAt = new Date('2026-10-12T12:00:00Z');
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            status: SupportRequestStatus.ACCEPTED,
            followUps: [
              { id: 'fu-1', status, dueAt, completedAt: null, professional },
            ],
          }),
        ]);

        const result = await service.listQueue('staff-1', {});

        expect(result.items[0]).toMatchObject({
          queueStatus: 'REVIEWED',
          followUpState: 'REQUIRED',
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
      },
    );

    it.each([
      { selectedOwner: 'other-staff', laterOwner: 'staff-1', canManage: false },
      { selectedOwner: 'staff-1', laterOwner: 'other-staff', canManage: true },
    ])(
      'bases all follow-up fields on the earliest open row, not another owned row (%j)',
      async ({ selectedOwner, laterOwner, canManage }) => {
        const dueAt = new Date('2026-10-12T12:00:00Z');
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            followUps: [
              {
                id: 'undated',
                status: 'PENDING',
                dueAt: null,
                completedAt: null,
                professional: { userId: laterOwner },
              },
              {
                id: 'later',
                status: 'PENDING',
                dueAt: new Date('2026-10-13T12:00:00Z'),
                completedAt: null,
                professional: { userId: laterOwner },
              },
              {
                id: 'closed',
                status: 'CANCELLED',
                dueAt: new Date('2026-10-11T12:00:00Z'),
                completedAt: null,
                professional: { userId: 'staff-1' },
              },
              {
                id: 'earliest',
                status: 'SCHEDULED',
                dueAt,
                completedAt: null,
                professional: { userId: selectedOwner },
              },
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
      },
    );

    it.each(['PENDING', 'SCHEDULED'])(
      'an open %s follow-up lands the row under Follow-Up Required without erasing the request status',
      async (status) => {
        const completedAt = new Date(Date.now() - DAY);
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            status: SupportRequestStatus.PENDING,
            followUps: [
              {
                id: 'done',
                status: 'COMPLETED',
                dueAt: null,
                completedAt,
                professional: { userId: 'staff-1' },
              },
              {
                id: 'open',
                status,
                dueAt: null,
                completedAt: null,
                professional: null,
              },
            ],
          }),
        ]);

        const result = await service.listQueue('staff-1', {
          status: 'FOLLOW_UP_REQUIRED',
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
          queueStatus: 'NEW',
          followUpState: 'REQUIRED',
          followUpId: 'open',
          followUpStatus: status,
          followUpCompletedAt: completedAt,
          canManageFollowUp: false,
        });
        expect(result.counts).toEqual({
          all: 1,
          new: 1,
          reviewed: 0,
          followUpRequired: 1,
          followUpCompleted: 0,
          completedThisWeek: 1,
        });
      },
    );

    it('counts completed-this-week only for follow-ups completed within 7 days', async () => {
      prisma.supportRequest.findMany.mockResolvedValue([
        queueRow({
          id: 'recent',
          followUps: [
            {
              id: 'fu-recent',
              status: 'COMPLETED',
              dueAt: null,
              completedAt: new Date(Date.now() - 2 * DAY),
              professional: null,
            },
          ],
        }),
        queueRow({
          id: 'stale',
          followUps: [
            {
              id: 'fu-stale',
              status: 'COMPLETED',
              dueAt: null,
              completedAt: new Date(Date.now() - 10 * DAY),
              professional: null,
            },
          ],
        }),
      ]);

      const result = await service.listQueue('staff-1', {});

      // The chip counts every completed follow-up, which is exactly the set
      // clicking it shows; the tile is the narrower 7-day window.
      expect(result.counts.followUpCompleted).toBe(2);
      expect(result.counts.completedThisWeek).toBe(1);
      expect(
        (await service.listQueue('staff-1', { status: 'FOLLOW_UP_COMPLETED' }))
          .items,
      ).toHaveLength(2);
    });

    it.each([
      { statuses: [] as string[] },
      { statuses: ['COMPLETED'] },
      { statuses: ['CANCELLED'] },
      { statuses: ['COMPLETED', 'CANCELLED'] },
    ])(
      'returns null open-follow-up fields and no management when none are open (%j)',
      async ({ statuses }) => {
        prisma.supportRequest.findMany.mockResolvedValue([
          queueRow({
            followUps: statuses.map((status) => ({
              id: `fu-${status}`,
              status,
              dueAt: null,
              completedAt: null,
              professional: { userId: 'staff-1' },
            })),
          }),
        ]);

        const result = await service.listQueue('staff-1', {});

        expect(result.items[0]).toMatchObject({
          followUpId: null,
          followUpStatus: null,
          followUpDueAt: null,
          canManageFollowUp: false,
          followUpState: statuses.includes('COMPLETED') ? 'COMPLETED' : 'NONE',
        });
      },
    );

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

      expect(
        result.items.find((i) => i.id === 'req-linked')?.conversationId,
      ).toBe('conv-9');
      expect(
        result.items.find((i) => i.id === 'req-plain')?.conversationId,
      ).toBeNull();
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

    it('narrows the chip counts by search too, so a number never exceeds its rows', async () => {
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
      // The counts describe the view, not the whole school: with a search term
      // typed, "All" is what the table actually holds.
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 1, new: 1, reviewed: 0 }),
      );
    });

    it('reports a search that matches nothing as an empty queue', async () => {
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
      ]);

      const result = await service.listQueue('staff-1', { q: 'nobody-here' });

      expect(result.items).toEqual([]);
      expect(result.counts).toEqual(
        expect.objectContaining({ all: 0, new: 0, reviewed: 0 }),
      );
    });
  });
});
