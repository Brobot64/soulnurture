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
      followUps: { select: { status: true } },
    },
  },
} satisfies Prisma.EmotionalCheckInInclude;

type HistoryRow = Prisma.EmotionalCheckInGetPayload<{
  include: typeof HISTORY_INCLUDE;
}>;

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

  async list(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const rows = await this.prisma.emotionalCheckIn.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      include: HISTORY_INCLUDE,
    });
    const items = rows.map((row) => this.project(row));
    return {
      items,
      counts: {
        all: items.length,
        checkIns: items.length,
        reflections: items.filter((item) => item.reflection !== null).length,
        supportRequests: items.filter((item) => item.supportRequest !== null).length,
      },
    };
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
    const queueRow: QueueRow | null = request
      ? {
          status: request.status,
          timing: request.timing,
          followUps: request.followUps,
        }
      : null;
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
      supportRequest:
        request === null || queueRow === null
          ? null
          : {
              id: request.id,
              createdAt: request.createdAt,
              status: request.status,
              queueStatus: deriveQueueStatus(queueRow),
              followUpState: deriveFollowUpState(queueRow),
              urgency: deriveUrgency(queueRow),
            },
    };
  }
}
