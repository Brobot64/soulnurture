import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  deriveFollowUpState,
  deriveQueueStatus,
  deriveUrgency,
  type QueueRow,
} from '../support-requests/queue-status.js';
import { StudentsService } from '../students/students.service.js';

/** The one read shape both the list and the detail share. */
const HISTORY_INCLUDE = {
  conversations: {
    orderBy: { updatedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      status: true,
      createdAt: true,
      summary: { select: { summary: true } },
      messages: {
        where: { role: 'USER' as const },
        select: { viaVoice: true },
      },
    },
  },
  supportRequests: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      status: true,
      timing: true,
      createdAt: true,
      checkInId: true,
      followUps: { select: { status: true } },
    },
  },
} satisfies Prisma.EmotionalCheckInInclude;

type HistoryRow = Prisma.EmotionalCheckInGetPayload<{
  include: typeof HISTORY_INCLUDE;
}>;

/** A request row, whichever way it was reached — from a check-in or on its own. */
type RequestRow = HistoryRow['supportRequests'][number];

/** Timeline page size. The client walks backwards with `before`, never all at once. */
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
/**
 * A ceiling, not a feature: one student's requests are few, and the page exists
 * so the response can never grow without bound the way the check-in list did.
 */
const REQUEST_WINDOW = 50;

function clampTake(raw?: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE;
  return Math.min(Math.floor(parsed), MAX_PAGE);
}

function parseCursor(raw?: string): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Epic H "My wellbeing history".
 *
 * A student's own timeline, composed only from rows that already exist: the
 * check-in, the reflection it led to, the support request it produced. No new
 * table and no new kind of record — which is what lets the page say "this is
 * your history" without embellishing it.
 *
 * Two things the design shows are absent because they have no source. Resource
 * counts ("2 resources shared") — nothing in the schema ties a wellbeing
 * resource to a check-in or a conversation, so a count would be an invented
 * link. And any statement about how long an entry is kept — no retention job
 * exists anywhere in the server.
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  /**
   * One page of the timeline, plus the student's support requests read straight
   * from `support_request`.
   *
   * The requests are a separate list on purpose. Counting them through the
   * check-in link (`supportRequest` on the row) silently reported zero, because
   * `checkInId` is nullable and the escalation path never fills it — a student
   * who had asked for help twice could be told they had never asked. The link is
   * still shown where it exists, so a request keeps its place in the timeline.
   *
   * Counts are totals, never page totals: a tab that says 214 means 214.
   */
  async list(userId: string, rawTake?: string, rawBefore?: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const take = clampTake(rawTake);
    const before = parseCursor(rawBefore);
    const scoped = { studentId: student.id };
    const pageWhere = before
      ? { ...scoped, createdAt: { lt: before } }
      : scoped;

    const [rows, requestRows, counts] = await Promise.all([
      this.prisma.emotionalCheckIn.findMany({
        where: pageWhere,
        orderBy: { createdAt: 'desc' },
        take: take + 1,
        include: HISTORY_INCLUDE,
      }),
      this.prisma.supportRequest.findMany({
        where: scoped,
        orderBy: { createdAt: 'desc' },
        take: REQUEST_WINDOW,
        select: {
          id: true,
          status: true,
          timing: true,
          createdAt: true,
          checkInId: true,
          followUps: { select: { status: true } },
        },
      }),
      this.countTotals(student.id),
    ]);

    const page = rows.slice(0, take);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.project(row)),
      supportRequests: requestRows.map((request) =>
        this.projectRequest(request),
      ),
      counts,
      page: {
        take,
        hasMore: rows.length > take,
        nextBefore: last ? last.createdAt.toISOString() : null,
      },
    };
  }

  private countTotals(studentId: string) {
    const scoped = { studentId };
    return Promise.all([
      this.prisma.emotionalCheckIn.count({ where: scoped }),
      this.prisma.emotionalCheckIn.count({
        where: { ...scoped, conversations: { some: {} } },
      }),
      this.prisma.supportRequest.count({ where: scoped }),
    ]).then(([checkIns, reflections, supportRequests]) => ({
      all: checkIns,
      checkIns,
      reflections,
      supportRequests,
    }));
  }

  /**
   * One entry opened by the student. The conversation messages are the
   * student's own turns and the AI's replies — read back to their owner.
   * Professional-only material (review notes, flags, audit rows) is not part
   * of this response, so the page cannot leak it by omission.
   */
  async detail(userId: string, checkInId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const row = await this.prisma.emotionalCheckIn.findFirst({
      where: { id: checkInId, studentId: student.id },
      include: HISTORY_INCLUDE,
    });
    if (!row) return null;
    const conversation = row.conversations[0] ?? null;
    return {
      ...this.project(row),
      description: row.description,
      messages: conversation
        ? await this.prisma.conversationMessage.findMany({
            where: { conversationId: conversation.id },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              role: true,
              content: true,
              language: true,
              viaVoice: true,
              createdAt: true,
            },
          })
        : [],
    };
  }

  private project(row: HistoryRow) {
    const conversation = row.conversations[0] ?? null;
    const turns = conversation?.messages ?? [];
    const request = row.supportRequests[0] ?? null;
    return {
      checkInId: row.id,
      createdAt: row.createdAt,
      feeling: row.feeling,
      intensity: row.intensity,
      triggers: row.triggers,
      reflection:
        conversation === null
          ? null
          : {
              conversationId: conversation.id,
              status: conversation.status,
              startedAt: conversation.createdAt,
              // Typed vs voice comes off the stored flag on the student's own
              // turns, never inferred from the text.
              turnCount: turns.length,
              viaVoice: turns.some((turn) => turn.viaVoice),
              // A summary exists only after the conversation closes, so null
              // here means "still open", not "missing".
              summary: conversation.summary?.summary ?? null,
            },
      supportRequest: request === null ? null : this.projectRequest(request),
    };
  }

  /**
   * The request's own state, derived with the same three functions the staff
   * queue uses, so a student and a professional never read different words for
   * one row. `checkInId` is included because it is often null: the escalation
   * path creates a request against the conversation only, and a history entry
   * must not be invented to cover that up.
   */
  private projectRequest(request: RequestRow) {
    const queueRow: QueueRow = {
      status: request.status,
      timing: request.timing,
      followUps: request.followUps,
    };
    return {
      id: request.id,
      createdAt: request.createdAt,
      status: request.status,
      checkInId: request.checkInId,
      queueStatus: deriveQueueStatus(queueRow),
      followUpState: deriveFollowUpState(queueRow),
      urgency: deriveUrgency(queueRow),
    };
  }
}
