import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FollowUpStatus,
  SupportFlagStatus,
  SupportPersonType,
  SupportRequestStatus,
  SupportTiming,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
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

@Injectable()
export class SupportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly auditService: AuditService,
  ) {}

  listPeople() {
    return this.prisma.supportPerson.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(userId: string, dto: CreateSupportRequestDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const person = await this.prisma.supportPerson.findFirst({
      where: { id: dto.supportPersonId, active: true },
    });
    if (!person) throw new NotFoundException('Support person not found');

    const status =
      dto.timing === SupportTiming.URGENT_UNSAFE
        ? SupportRequestStatus.ESCALATED
        : SupportRequestStatus.PENDING;

    const request = await this.prisma.supportRequest.create({
      data: {
        studentId: student.id,
        supportPersonId: person.id,
        personType: dto.personType,
        timing: dto.timing,
        note: dto.note,
        checkInId: dto.checkInId,
        conversationId: dto.conversationId,
        status,
      },
      include: { supportPerson: true },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.created',
      entity: 'SupportRequest',
      entityId: request.id,
      meta: { timing: dto.timing, status },
    });

    return request;
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.supportRequest.findMany({
      where: { studentId: student.id },
      include: { supportPerson: true },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const item = await this.prisma.supportRequest.findUnique({
      where: { id },
      include: { supportPerson: true },
    });
    if (!item) throw new NotFoundException('Support request not found');
    if (item.studentId !== student.id) throw new ForbiddenException();
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
          select: { id: true, status: true, dueAt: true, completedAt: true },
        },
        supportPerson: { select: { id: true, name: true, type: true } },
        student: {
          select: {
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
        toQueueItem(request, queueStatus, prompt),
      );

    return { items, counts };
  }

  /**
   * Counsellor review (report simplified scope: status plus notes).
   * Professionals progress a request through its review statuses and attach
   * a review note; students see the updated status in their own list.
   */
  async review(
    userId: string,
    id: string,
    dto: ReviewSupportRequestDto,
  ) {
    const existing = await this.prisma.supportRequest.findUnique({
      where: { id },
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

    return updated;
  }
}

// --- Staff queue row shape --------------------------------------------------

export interface SupportQueueStudent {
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
  reviewNote: string | null;
  requestStatus: SupportRequestStatus;
  queueStatus: QueueStatus;
  prompt: SupportPrompt;
  followUpId: string | null;
  followUpDueAt: Date | null;
  followUpCompletedAt: Date | null;
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
  reviewNote: string | null;
  status: SupportRequestStatus;
  conversationId: string | null;
  followUps: {
    id: string;
    status: FollowUpStatus;
    dueAt: Date | null;
    completedAt: Date | null;
  }[];
  supportPerson: {
    id: string;
    name: string;
    type: SupportPersonType;
  } | null;
  student: {
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
    reviewNote: request.reviewNote,
    requestStatus: request.status,
    queueStatus,
    prompt,
    followUpId: openFollowUps[0]?.id ?? null,
    followUpDueAt: openFollowUps[0]?.dueAt ?? null,
    followUpCompletedAt: lastCompletedAt,
    student: { ...student, email: user.email },
    supportPerson: request.supportPerson,
  };
}
