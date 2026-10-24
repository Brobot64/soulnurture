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
import { inSchool, schoolOf, supportPeopleInSchool } from '../common/tenant/school-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto.js';
import type { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';
import {
  deriveQueueStatus,
  isActiveFlagStatus,
  isWithinCompletedWeek,
  type QueueStatus,
  type SupportPrompt,
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
   * Staff queue (figma node 146:914): the school's support requests with a
   * derived review-queue status, prompt pill, tile counts and optional
   * status filter / student-ID-email search. Professionals only see their
   * own school (the design footnote: "You only see requests you are
   * authorised to view"). Chip counts always describe the whole school
   * queue — search and chip selection narrow the table only.
   */
  async listQueue(
    userId: string,
    filters: { status?: QueueStatus; q?: string },
  ): Promise<SupportQueueResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { schoolId: true },
    });
    if (!user?.schoolId) return { items: [], counts: emptyQueueCounts() };

    const search = filters.q?.trim().toLowerCase();
    // School scope only — chip counts must describe the whole school queue
    // even while search narrows the table rows.
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
      prompt: (
        request.conversationId && flagged.has(request.conversationId)
          ? 'REVIEW_SUGGESTED'
          : 'NONE'
      ) as SupportPrompt,
    }));

    const counts: SupportQueueCounts = {
      all: derived.length,
      new: 0,
      reviewed: 0,
      followUpRequired: 0,
      followUpCompleted: 0,
    };
    for (const row of derived) {
      if (row.queueStatus === 'NEW') counts.new += 1;
      else if (row.queueStatus === 'REVIEWED') counts.reviewed += 1;
      else if (row.queueStatus === 'FOLLOW_UP_REQUIRED') {
        counts.followUpRequired += 1;
      } else if (
        row.request.followUps.some(
          (followUp) =>
            followUp.completedAt &&
            isWithinCompletedWeek(followUp.completedAt, now),
        )
      ) {
        counts.followUpCompleted += 1;
      }
    }

    const items = derived
      .filter((row) => !filters.status || row.queueStatus === filters.status)
      .filter(
        (row) =>
          !search ||
          [row.request.student.studentCode, row.request.student.studentRef, row.request.student.user.email]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(search)),
      )
      .map(({ request, queueStatus, prompt }) =>
        toQueueItem(request, queueStatus, prompt, userId),
      );

    return { items, counts };
  }

  /**
   * Counsellor review (report simplified scope: status plus notes).
   * Professionals progress a request through its review statuses and attach
   * a review note; students see the updated status in their own list. The
   * lookup is tenant-scoped: a request belonging to another school reads as
   * absent, so no professional can progress rows they are not entitled to.
   */
  async review(
    userId: string,
    id: string,
    dto: ReviewSupportRequestDto,
  ) {
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
      },
      include: { supportPerson: true },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.status_changed',
      entity: 'SupportRequest',
      entityId: id,
      meta: { from: existing.status, to: dto.status },
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

    return { ...updated, chatThreadId };
  }
}

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
  requestStatus: SupportRequestStatus;
  queueStatus: QueueStatus;
  prompt: SupportPrompt;
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
  };
}

function toQueueItem(
  request: QueueRequestRow,
  queueStatus: QueueStatus,
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
    prompt,
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
