import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HistoryDeletionScope, Prisma } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { RequestHistoryDeletionDto } from './dto/request-history-deletion.dto.js';

export const HISTORY_DELETION_NOTIFICATION_TYPE = 'HISTORY_DELETION_REQUEST';

/** The roles that already read this student's wellbeing content, and no wider. */
const REVIEWER_ROLES = ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] as const;

const RECEIPT_SELECT = {
  id: true,
  scope: true,
  beforeDate: true,
  checkInIds: true,
  note: true,
  alertedAt: true,
  createdAt: true,
} satisfies Prisma.HistoryDeletionRequestSelect;

/**
 * Epic H: a student's ask that their history be removed.
 *
 * This service writes a request and tells a person about it. It never deletes
 * anything, and that is not laziness: some of what a student shares may have to
 * be kept for safeguarding or for the school's own legal duties, so the decision
 * belongs to a named professional, not to a CRUD handler. The row keeps the ask
 * exactly as submitted — scope, date or ids, and the student's own words — so the
 * decision is made against what was actually requested.
 */
@Injectable()
export class HistoryDeletionService {
  private readonly logger = new Logger(HistoryDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: RequestHistoryDeletionDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const data = await this.validate(student.id, dto);

    const row = await this.prisma.historyDeletionRequest.create({
      data,
      select: RECEIPT_SELECT,
    });

    const alertedAt = await this.alertReviewers(row.id, student.id, dto);
    if (alertedAt) {
      await this.prisma.historyDeletionRequest.update({
        where: { id: row.id },
        data: { alertedAt },
      });
    }
    return { ...row, alertedAt };
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.historyDeletionRequest.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      select: RECEIPT_SELECT,
    });
    return { items };
  }

  /**
   * The scope decides which fields mean anything, so a mismatch is refused
   * rather than half-honoured: a "delete everything" ask carrying a stray date
   * would be a different request than the one a reviewer reads.
   */
  private async validate(studentId: string, dto: RequestHistoryDeletionDto) {
    const hasDate = dto.beforeDate !== undefined;
    const hasIds = dto.checkInIds !== undefined && dto.checkInIds.length > 0;

    if (dto.scope === HistoryDeletionScope.ALL_HISTORY) {
      if (hasDate || hasIds) {
        throw new BadRequestException({
          code: 'SCOPE_FIELDS_MISMATCH',
          message: 'ALL_HISTORY takes no date and no check-in ids',
        });
      }
    }

    if (dto.scope === HistoryDeletionScope.BEFORE_DATE) {
      if (!hasDate || hasIds) {
        throw new BadRequestException({
          code: 'SCOPE_FIELDS_MISMATCH',
          message: 'BEFORE_DATE needs beforeDate and no check-in ids',
        });
      }
    }

    if (dto.scope === HistoryDeletionScope.SELECTED_CHECK_INS) {
      if (!hasIds || hasDate) {
        throw new BadRequestException({
          code: 'SCOPE_FIELDS_MISMATCH',
          message: 'SELECTED_CHECK_INS needs checkInIds and no date',
        });
      }
      const ids = [...new Set(dto.checkInIds ?? [])];
      const owned = await this.prisma.emotionalCheckIn.findMany({
        where: { studentId, id: { in: ids } },
        select: { id: true },
      });
      if (owned.length !== ids.length) {
        // Deliberately unspecific: whether the id exists at all is not this
        // student's information.
        throw new BadRequestException({
          code: 'CHECK_INS_NOT_FOUND',
          message: 'Some of those check-ins are not yours',
        });
      }
      return {
        studentId,
        scope: dto.scope,
        beforeDate: null,
        checkInIds: ids,
        note: dto.note?.trim() ? dto.note.trim() : null,
      } satisfies Prisma.HistoryDeletionRequestUncheckedCreateInput;
    }

    return {
      studentId,
      scope: dto.scope,
      beforeDate: dto.scope === HistoryDeletionScope.BEFORE_DATE ? new Date(dto.beforeDate!) : null,
      checkInIds: [],
      note: dto.note?.trim() ? dto.note.trim() : null,
    } satisfies Prisma.HistoryDeletionRequestUncheckedCreateInput;
  }

  /**
   * A person is told, because "your request is reviewed" is only honest if
   * someone actually receives it. Failure never fails the request — the ask is
   * stored either way — but it does leave `alertedAt` null, so the receipt can
   * say the review was not arranged instead of promising one.
   */
  private async alertReviewers(
    requestId: string,
    studentId: string,
    dto: RequestHistoryDeletionDto,
  ): Promise<Date | null> {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: {
        studentRef: true,
        displayName: true,
        firstName: true,
        user: { select: { schoolId: true } },
      },
    });
    const schoolId = student?.user.schoolId ?? null;
    if (!schoolId) return null;

    const recipients = await this.prisma.user.findMany({
      where: { schoolId, deactivatedAt: null, role: { in: [...REVIEWER_ROLES] } },
      select: { id: true },
    });
    if (recipients.length === 0) return null;

    const label = student?.studentRef ?? student?.displayName ?? student?.firstName ?? 'Student';
    const note = dto.note?.trim()
      ? ` — student's words: “${dto.note.trim().slice(0, 180).replace(/\s+/g, ' ')}”`
      : '';
    try {
      await this.notifications.pushMany({
        userIds: recipients.map((user) => user.id),
        type: HISTORY_DELETION_NOTIFICATION_TYPE,
        title: 'A student has asked for their history to be deleted',
        body: `Student ${label} asked to remove ${describeScope(dto)}.${note} Nothing has been removed — review what must be kept for safeguarding or legal reasons and tell the student the outcome.`,
        data: { requestId, studentId, schoolId, scope: dto.scope },
      });
      return new Date();
    } catch (error) {
      this.logger.warn(
        `History deletion request ${requestId} stored but no reviewer was notified: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

function describeScope(dto: RequestHistoryDeletionDto): string {
  if (dto.scope === HistoryDeletionScope.BEFORE_DATE) {
    return `everything before ${dto.beforeDate}`;
  }
  if (dto.scope === HistoryDeletionScope.SELECTED_CHECK_INS) {
    return `${dto.checkInIds?.length ?? 0} selected check-in(s)`;
  }
  return 'all of their history';
}
