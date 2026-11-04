import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HistoryDeletionScope, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { HistoryPurgeService } from './history-purge.service.js';
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
  scheduledPurgeAt: true,
  cancelledAt: true,
  purgedAt: true,
  holdReason: true,
  removedCheckIns: true,
  removedConversations: true,
  createdAt: true,
} satisfies Prisma.HistoryDeletionRequestSelect;

/**
 * Epic H: a student's ask that their history be removed.
 *
 * The owner's ruling of 2026-11-04 settled what this path does with it: the
 * student decides, the erasure is scheduled 24 hours out so they can change
 * their mind, and `HistoryPurgeService` carries it out. This service therefore
 * writes the ask, schedules it, and can cancel it inside the window — and never
 * deletes anything itself, which keeps the undo path in one place.
 *
 * The row keeps the ask exactly as submitted — scope, date or ids, and the
 * student's own words — so what was erased is reconstructable from what was
 * actually requested.
 */
@Injectable()
export class HistoryDeletionService {
  private readonly logger = new Logger(HistoryDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly notifications: NotificationsService,
    private readonly auditService: AuditService,
    private readonly purge: HistoryPurgeService,
  ) {}

  async create(userId: string, dto: RequestHistoryDeletionDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const data = await this.validate(student.id, dto);
    const scheduledPurgeAt = this.purge.scheduledPurgeAt();

    const row = await this.prisma.historyDeletionRequest.create({
      data: { ...data, scheduledPurgeAt },
      select: RECEIPT_SELECT,
    });

    const alertedAt = await this.alertReviewers(
      row.id,
      student.id,
      dto,
      scheduledPurgeAt,
    );
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
   * The 24-hour undo. One atomic statement carries the whole rule — the ask must
   * be theirs, not yet purged, not already cancelled, and still inside its
   * window — so a cancel racing the worker loses cleanly instead of half-working.
   *
   * A cancel after the erasure has run is not a conflict about the request; it is
   * the honest answer that there is nothing left to cancel, so the messages name
   * which of the three states the ask was in.
   */
  async cancel(userId: string, requestId: string) {
    const student = await this.studentsService.ensureProfile(userId);

    const [cancelled] = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE history_deletion_request
      SET "cancelledAt" = NOW()
      WHERE id = ${requestId}::uuid
        AND "studentId" = ${student.id}::uuid
        AND "cancelledAt" IS NULL
        AND "purgedAt" IS NULL
        AND "scheduledPurgeAt" > NOW()
      RETURNING id`;
    if (cancelled) {
      const row = await this.prisma.historyDeletionRequest.findUnique({
        where: { id: requestId },
        select: RECEIPT_SELECT,
      });
      await this.auditService.log({
        actorId: userId,
        schoolId: await this.schoolOf(userId),
        action: 'history_deletion.cancelled',
        entity: 'HistoryDeletionRequest',
        entityId: requestId,
        meta: { scope: row?.scope ?? null },
      });
      return row;
    }

    const state = await this.prisma.historyDeletionRequest.findFirst({
      where: { id: requestId, studentId: student.id },
      select: { purgedAt: true, cancelledAt: true, scheduledPurgeAt: true },
    });
    if (!state) throw new NotFoundException('Deletion request not found');
    if (state.cancelledAt) {
      throw new ConflictException({
        code: 'ALREADY_CANCELLED',
        message: 'This request was already cancelled',
      });
    }
    if (state.purgedAt) {
      throw new ConflictException({
        code: 'ALREADY_REMOVED',
        message: 'The removal has already happened — it can no longer be undone',
      });
    }
    throw new ConflictException({
      code: 'WINDOW_CLOSED',
      message:
        'The 24-hour window has closed, so the removal is being carried out now',
    });
  }

  private async schoolOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { schoolId: true },
    });
    return user?.schoolId ?? null;
  }

  /**
   * The scope decides which fields mean anything, so a mismatch is refused
   * rather than half-honoured: a "delete everything" ask carrying a stray date
   * would be a different request than the one the engine would carry out.
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
   * A person at the school is told, because a removal that quietly empties a
   * counsellor's queue without warning them is not a good-faith product. They are
   * told as a matter of record, not asked to decide: the owner's ruling put that
   * with the student. Failure never fails the request — the ask is stored and
   * scheduled either way — but it leaves `alertedAt` null, so the receipt can say
   * nobody was told instead of promising a notice that never arrived.
   */
  private async alertReviewers(
    requestId: string,
    studentId: string,
    dto: RequestHistoryDeletionDto,
    scheduledPurgeAt: Date,
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
        title: 'A student has scheduled their own history for removal',
        body:
          `Student ${label} asked to remove ${describeScope(dto)}. This is their decision, not one you are being` +
          ` asked to make: it takes effect ${describeWhen(scheduledPurgeAt)} and they can cancel until then.${note}` +
          ` Nothing has been removed yet. If the ask is for all of their history, the removal takes the whole` +
          ` account with it — including any safeguarding flag raised on it — out of our live systems.`,
        data: {
          requestId,
          studentId,
          schoolId,
          scope: dto.scope,
          scheduledPurgeAt: scheduledPurgeAt.toISOString(),
        },
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
  // Named plainly, because a staff member who reads this as "some check-ins"
  // will be surprised by an empty account.
  return (
    'their entire history — every check-in, chat, journal entry, support request' +
    ' and safeguarding record, and the login itself'
  );
}

/** UTC and to the minute: a staff notification must not depend on the reader's
 * clock to know when the window closes. */
function describeWhen(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
