import { Injectable, NotFoundException } from '@nestjs/common';
import {
  FollowUpStatus,
  SupportFlagStatus,
  SupportPersonType,
  SupportRequestStatus,
  MessageRole,
  SupportTiming,
  type Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ChatService } from '../chat/chat.service.js';
import {
  inSchool,
  schoolOf,
  supportPeopleInSchool,
} from '../common/tenant/school-scope.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto.js';
import type { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';
import {
  deriveFollowUpState,
  deriveQueueStatus,
  deriveUrgency,
  isActiveFlagStatus,
  isWithinCompletedWeek,
  matchesQueueFilter,
  type FollowUpState,
  type QueueFilter,
  type QueueStatus,
  type SupportPrompt,
  type Urgency,
} from './queue-status.js';

const STUDENT_REQUEST_SELECT = {
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
} satisfies Prisma.SupportRequestSelect;

@Injectable()
export class SupportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly auditService: AuditService,
    private readonly chatService: ChatService,
    private readonly notifications: NotificationsService,
  ) {}

  async listPeople(userId: string) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) return [];
    return this.prisma.supportPerson.findMany({
      where: supportPeopleInSchool(schoolId),
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
  }

  async create(userId: string, dto: CreateSupportRequestDto) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) throw new NotFoundException('Support person not found');
    const person = await this.prisma.supportPerson.findFirst({
      where: {
        id: dto.supportPersonId,
        type: dto.personType,
        ...supportPeopleInSchool(schoolId),
      },
    });
    if (!person) throw new NotFoundException('Support person not found');
    const student = await this.studentsService.ensureProfile(userId);

    const status =
      dto.timing === SupportTiming.URGENT_UNSAFE
        ? SupportRequestStatus.ESCALATED
        : SupportRequestStatus.PENDING;

    const initial = dto.conversationId
      ? await this.snapshotInitialMessage(student.id, dto.conversationId)
      : null;

    const request = await this.prisma.supportRequest.create({
      data: {
        studentId: student.id,
        supportPersonId: person.id,
        personType: dto.personType,
        timing: dto.timing,
        note: dto.note,
        checkInId: dto.checkInId,
        conversationId: dto.conversationId,
        initialMessage: initial?.content ?? null,
        initialMessageAt: initial?.createdAt ?? null,
        status,
      },
      select: STUDENT_REQUEST_SELECT,
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.created',
      entity: 'SupportRequest',
      entityId: request.id,
      meta: { timing: dto.timing, status },
      schoolId,
    });

    return request;
  }

  /**
   * Freezes the student's latest own message in the conversation the request
   * was raised from. The conversation must belong to the requesting student;
   * a foreign conversation id answers 404 so nothing is copied from it.
   */
  private async snapshotInitialMessage(studentId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, studentId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return this.prisma.conversationMessage.findFirst({
      where: { conversationId, role: MessageRole.USER },
      orderBy: { createdAt: 'desc' },
      select: { content: true, createdAt: true },
    });
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.supportRequest.findMany({
      where: { studentId: student.id },
      select: STUDENT_REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const item = await this.prisma.supportRequest.findFirst({
      where: { id, studentId: student.id },
      select: STUDENT_REQUEST_SELECT,
    });
    if (!item) throw new NotFoundException('Support request not found');
    return item;
  }

  /**
   * Staff queue (figma node 146:914): the school's support requests, each with
   * the four independent facts the screen renders — stored lifecycle,
   * NEW/REVIEWED chip split, follow-up state and urgency — plus tile counts and
   * optional chip filter / student-ID-email search. Professionals only see
   * their own school (the design footnote: "You only see requests you are
   * authorised to view"). Urgent requests sort first, then newest.
   * Chip counts always describe the whole school queue — search and chip
   * selection narrow the table only — and each count is produced by the same
   * `matchesQueueFilter` predicate that selects the rows below.
   */
  async listQueue(
    userId: string,
    filters: { status?: QueueFilter; q?: string },
  ): Promise<SupportQueueResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { schoolId: true },
    });
    if (!user?.schoolId) return { items: [], counts: emptyQueueCounts() };

    const search = filters.q?.trim().toLowerCase();
    // School scope only: a reviewer sees their own school's queue and nothing
    // else. The search term narrows the whole response, counts included.
    const requests = await this.prisma.supportRequest.findMany({
      where: {
        status: { not: SupportRequestStatus.CANCELLED },
        student: { user: { schoolId: user.schoolId } },
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
      orderBy: { createdAt: 'desc' },
    });

    const conversationIds = requests
      .map((request) => request.conversationId)
      .filter((id): id is string => Boolean(id));
    const flagged = new Set<string>();
    if (conversationIds.length > 0) {
      const flags = await this.prisma.supportFlag.findMany({
        where: {
          conversationId: { in: conversationIds },
          status: {
            in: [
              SupportFlagStatus.OPEN,
              SupportFlagStatus.IN_REVIEW,
              SupportFlagStatus.ESCALATED,
            ],
          },
        },
        select: { conversationId: true, status: true },
      });
      for (const flag of flags) {
        if (isActiveFlagStatus(flag.status)) flagged.add(flag.conversationId!);
      }
    }

    const now = new Date();
    const derived = requests.map((request) => ({
      request,
      queueStatus: deriveQueueStatus(request),
      followUpState: deriveFollowUpState(request),
      urgency: deriveUrgency(request),
      prompt: (request.conversationId && flagged.has(request.conversationId)
        ? 'REVIEW_SUGGESTED'
        : 'NONE') as SupportPrompt,
    }));

    // The search narrows the view, and every number on the screen describes
    // that view — a chip that says 3 has 3 rows behind it, and the table
    // showing 1 row under "New (8)" is the same lie this queue just shipped.
    const visible = search
      ? derived.filter(
          (row) =>
            [
              row.request.student.studentCode,
              row.request.student.studentRef,
              row.request.student.user.email,
            ]
              .filter((value): value is string => Boolean(value))
              .some((value) => value.toLowerCase().includes(search)),
        )
      : derived;

    // Every chip's count is the exact set `matchesQueueFilter` returns below —
    // counts and rows are computed from one predicate, so they cannot drift.
    const counts: SupportQueueCounts = {
      all: visible.length,
      new: 0,
      reviewed: 0,
      followUpRequired: 0,
      followUpCompleted: 0,
      completedThisWeek: 0,
    };
    for (const row of visible) {
      if (matchesQueueFilter(row.request, 'NEW')) counts.new += 1;
      if (matchesQueueFilter(row.request, 'REVIEWED')) counts.reviewed += 1;
      if (matchesQueueFilter(row.request, 'FOLLOW_UP_REQUIRED')) {
        counts.followUpRequired += 1;
      }
      if (matchesQueueFilter(row.request, 'FOLLOW_UP_COMPLETED')) {
        counts.followUpCompleted += 1;
      }
      if (
        row.request.followUps.some(
          (followUp) =>
            followUp.completedAt &&
            isWithinCompletedWeek(followUp.completedAt, now),
        )
      ) {
        counts.completedThisWeek += 1;
      }
    }

    const items = visible
      // Urgent first, then newest: the queue must not order a "I do not feel
      // safe right now" request by the clock alone.
      .sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency === 'URGENT' ? -1 : 1;
        return b.request.createdAt.getTime() - a.request.createdAt.getTime();
      })
      .filter(
        (row) =>
          !filters.status || matchesQueueFilter(row.request, filters.status),
      )
      .map(({ request, queueStatus, followUpState, urgency, prompt }) =>
        toQueueItem(
          request,
          queueStatus,
          followUpState,
          urgency,
          prompt,
          userId,
        ),
      );

    return { items, counts };
  }

  /**
   * Counsellor review (report simplified scope: status plus notes).
   * Professionals progress a request through its review statuses and attach
   * a review note; students see the updated status in their own list and get
   * one notification per real change, so a status never moves silently. The
   * lookup is tenant-scoped: a request belonging to another school reads as
   * absent, so no professional can progress rows they are not entitled to.
   */
  async review(userId: string, id: string, dto: ReviewSupportRequestDto) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) throw new NotFoundException('Support request not found');
    const existing = await this.prisma.supportRequest.findFirst({
      where: { id, ...inSchool(schoolId) },
    });
    if (!existing) throw new NotFoundException('Support request not found');

    const updated = await this.prisma.supportRequest.update({
      where: { id },
      data: {
        status: dto.status,
        reviewNote: dto.reviewNote ?? existing.reviewNote,
        // A reschedule replaces the old arrangement; anything else leaves it
        // exactly as the student last saw it.
        ...(dto.scheduledAt ? { scheduledAt: new Date(dto.scheduledAt) } : {}),
        ...(dto.locationLabel ? { locationLabel: dto.locationLabel } : {}),
      },
      include: { supportPerson: true },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.status_changed',
      entity: 'SupportRequest',
      entityId: id,
      meta: {
        from: existing.status,
        to: dto.status,
        scheduledAt: dto.scheduledAt ?? null,
      },
    });

    let chatThreadId: string | null = null;
    if (dto.status === SupportRequestStatus.ACCEPTED) {
      const staff = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const note = existing.note?.trim();
      const said = existing.initialMessage?.trim();
      const summary =
        `${staff?.name ?? 'A counsellor'} accepted your request to talk.` +
        (note ? ` You asked: "${note}"` : '') +
        (said && said !== note ? ` You said: "${said}"` : '');
      const opened = await this.chatService.openDirectThread(userId, {
        studentProfileId: existing.studentId,
        schoolId,
        summary,
      });
      chatThreadId = opened.id;
    }

    // Only a change tells the student. Saving the same status with an edited
    // note is a staff-side correction, not a new event in the student's week.
    if (dto.status !== existing.status) {
      await this.notifyStudentOfStatus(
        existing.studentId,
        id,
        dto.status,
        updated.supportPerson?.name,
      );
    }

    return { ...updated, chatThreadId };
  }

  /**
   * The student's own notification: what changed and where to read it. Never
   * carries `reviewNote` — that field is private staff reasoning — and never
   * promises a response, only what the recorded status now is.
   */
  private async notifyStudentOfStatus(
    studentId: string,
    requestId: string,
    status: SupportRequestStatus,
    supportPersonName: string | null | undefined,
  ) {
    const copy = STUDENT_STATUS_NOTIFICATIONS[status];
    if (!copy) return;
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (!student) return;
    const by = supportPersonName?.trim();
    await this.notifications.push({
      userId: student.userId,
      type: SUPPORT_STATUS_NOTIFICATION_TYPE,
      title: copy.title,
      body: by ? `${by} — ${copy.body}` : copy.body,
      data: { requestId, status },
    });
  }
}

// --- Student-facing status alerts -------------------------------------------

export const SUPPORT_STATUS_NOTIFICATION_TYPE = 'SUPPORT_REQUEST_STATUS';

const STUDENT_STATUS_NOTIFICATIONS: Partial<
  Record<SupportRequestStatus, { title: string; body: string }>
> = {
  [SupportRequestStatus.ACCEPTED]: {
    title: 'Your support request was accepted',
    body: 'A school professional accepted your request to talk. Open the request to see its details.',
  },
  [SupportRequestStatus.SCHEDULED]: {
    title: 'Your support request is marked as scheduled',
    body: 'A time and location may have been added to your request. Check the request details and ask your school to confirm the arrangement.',
  },
  [SupportRequestStatus.IN_PROGRESS]: {
    title: 'Support for your request is in progress',
    body: 'A school professional marked your request as in progress. Follow the arrangements you agreed with your school.',
  },
  [SupportRequestStatus.COMPLETED]: {
    title: 'Your support request is complete',
    body: 'A school professional marked this request as completed. You can ask to talk again any time you need support.',
  },
  [SupportRequestStatus.CANCELLED]: {
    title: 'Your support request was cancelled',
    body: 'This request was marked as cancelled. You can ask to talk again if you still need support.',
  },
};

// --- Staff queue row shape --------------------------------------------------

export interface SupportQueueStudent {
  id: string;
  firstName: string;
  lastName: string | null;
  displayName: string | null;
  classLabel: string | null;
  studentCode: string | null;
  studentRef: string | null;
  email: string;
}

export interface SupportQueueItem {
  id: string;
  requestedAt: Date;
  timing: SupportTiming;
  note: string | null;
  initialMessage: string | null;
  initialMessageAt: Date | null;
  reviewNote: string | null;
  /** The stored lifecycle — what actually happened to this request. */
  requestStatus: SupportRequestStatus;
  /** Coarse chip split: has a professional acted yet (NEW vs REVIEWED)? */
  queueStatus: QueueStatus;
  /** Independent of `queueStatus`: is a follow-up open / done / never booked. */
  followUpState: FollowUpState;
  /** Independent of both: did the student say they do not feel safe. */
  urgency: Urgency;
  prompt: SupportPrompt;
  /** The arrangement the student can already see, so the review dialog can
   * prefill instead of silently blanking it on the next save. */
  scheduledAt: Date | null;
  locationLabel: string | null;
  followUpId: string | null;
  followUpStatus: FollowUpStatus | null;
  canManageFollowUp: boolean;
  followUpDueAt: Date | null;
  followUpCompletedAt: Date | null;
  conversationId: string | null;
  student: SupportQueueStudent;
  supportPerson: { id: string; name: string; type: SupportPersonType } | null;
}

export interface SupportQueueCounts {
  all: number;
  new: number;
  reviewed: number;
  followUpRequired: number;
  followUpCompleted: number;
  /** The "Completed this week" tile: a rolling 7-day window, narrower than
   * the `followUpCompleted` chip, which counts every completed follow-up. */
  completedThisWeek: number;
}

export interface SupportQueueResult {
  items: SupportQueueItem[];
  counts: SupportQueueCounts;
}

type QueueRequestRow = {
  id: string;
  createdAt: Date;
  timing: SupportTiming;
  note: string | null;
  initialMessage: string | null;
  initialMessageAt: Date | null;
  reviewNote: string | null;
  status: SupportRequestStatus;
  scheduledAt: Date | null;
  locationLabel: string | null;
  conversationId: string | null;
  followUps: {
    id: string;
    status: FollowUpStatus;
    dueAt: Date | null;
    completedAt: Date | null;
    professional: { userId: string } | null;
  }[];
  supportPerson: {
    id: string;
    name: string;
    type: SupportPersonType;
  } | null;
  student: {
    id: string;
    firstName: string;
    lastName: string | null;
    displayName: string | null;
    classLabel: string | null;
    studentCode: string | null;
    studentRef: string | null;
    user: { email: string };
  };
};

function emptyQueueCounts(): SupportQueueCounts {
  return {
    all: 0,
    new: 0,
    reviewed: 0,
    followUpRequired: 0,
    followUpCompleted: 0,
    completedThisWeek: 0,
  };
}

function toQueueItem(
  request: QueueRequestRow,
  queueStatus: QueueStatus,
  followUpState: FollowUpState,
  urgency: Urgency,
  prompt: SupportPrompt,
  userId: string,
): SupportQueueItem {
  const openFollowUps = request.followUps
    .filter(
      (followUp) =>
        followUp.status === FollowUpStatus.PENDING ||
        followUp.status === FollowUpStatus.SCHEDULED,
    )
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );
  const selectedFollowUp = openFollowUps[0];
  const lastCompletedAt = request.followUps
    .filter((followUp) => followUp.status === FollowUpStatus.COMPLETED)
    .reduce<Date | null>(
      (latest, followUp) =>
        followUp.completedAt &&
        (!latest || followUp.completedAt.getTime() > latest.getTime())
          ? followUp.completedAt
          : latest,
      null,
    );
  const { user, ...student } = request.student;
  return {
    id: request.id,
    requestedAt: request.createdAt,
    timing: request.timing,
    note: request.note,
    initialMessage: request.initialMessage,
    initialMessageAt: request.initialMessageAt,
    reviewNote: request.reviewNote,
    requestStatus: request.status,
    queueStatus,
    followUpState,
    urgency,
    prompt,
    scheduledAt: request.scheduledAt,
    locationLabel: request.locationLabel,
    followUpId: selectedFollowUp?.id ?? null,
    followUpStatus: selectedFollowUp?.status ?? null,
    canManageFollowUp: selectedFollowUp?.professional?.userId === userId,
    followUpDueAt: selectedFollowUp?.dueAt ?? null,
    followUpCompletedAt: lastCompletedAt,
    conversationId: request.conversationId,
    student: { ...student, email: user.email },
    supportPerson: request.supportPerson,
  };
}
