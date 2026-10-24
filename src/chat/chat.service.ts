import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EmotionalCheckIn } from '@prisma/client';
import { AiService } from '../ai/ai.service.js';
import { RateLimitExceededException } from '../ai/guardrails/guardrail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_EVENTS } from '../realtime/realtime.events.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { StudentsService } from '../students/students.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import type { CreateChatThreadDto } from './dto/create-chat-thread.dto.js';
import type { SendChatMessageDto } from './dto/send-chat-message.dto.js';

const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const PREVIEW_CHARS = 120;

interface WindowCounter {
  count: number;
  expiresAt: number;
}

/// Read lazily per call — the module graph (and thus `.env`) may not be
/// loaded when this service is first constructed.
function chatRateLimitPerMinute(): number {
  const parsed = Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

function humanize(enumValue: string): string {
  return enumValue.replaceAll('_', ' ').toLowerCase();
}

function preview(content: string): string {
  return content.length > PREVIEW_CHARS
    ? `${content.slice(0, PREVIEW_CHARS).trimEnd()}…`
    : content;
}

type CheckInContext = Pick<EmotionalCheckIn, 'feeling' | 'intensity' | 'triggers'>;

// Keep raw student notes out of fallback summaries used in notifications.
function fallbackEntryNote(input: {
  firstName: string;
  classLabel: string | null;
  checkIn: CheckInContext | null;
}): string {
  const opening = `${input.firstName}${
    input.classLabel ? ` (${input.classLabel})` : ''
  } asked to talk with someone.`;
  if (!input.checkIn) return opening;
  const sentences = [
    opening,
    `Their latest check-in was feeling ${humanize(input.checkIn.feeling)} ` +
      `at ${humanize(input.checkIn.intensity)} intensity.`,
  ];
  if (input.checkIn.triggers.length > 0) {
    sentences.push(`They mentioned ${input.checkIn.triggers.join(', ')}.`);
  }
  return sentences.join(' ');
}

/**
 * In-app human chat (Phase 6): student requests → shared PENDING pool of the
 * school's professionals → claim → messages → close. Fully separate from the
 * AI conversation lane — no AI replies live in a thread, and the only AI is
 * the entry-note composer, which degrades to deterministic copy. Mutations
 * are REST; live updates are pushed over Socket.IO (DB first, then emit).
 */
@Injectable()
export class ChatService {
  private readonly messageWindows = new Map<string, WindowCounter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly aiService: AiService,
    private readonly studentsService: StudentsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  async createThread(userId: string, dto: CreateChatThreadDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        schoolId: true,
        school: { select: { id: true, status: true } },
      },
    });
    if (!user?.schoolId || !user.school) {
      throw new UnprocessableEntityException({
        code: 'NO_SCHOOL',
        message:
          'Your account is not linked to a school yet. Ask your school administrator to add you.',
      });
    }
    if (user.school.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'SCHOOL_SUSPENDED',
        message:
          'Your school account is currently suspended. Contact your school administrator.',
      });
    }

    const student = await this.studentsService.ensureProfile(userId);

    const open = await this.prisma.chatThread.findFirst({
      where: { studentId: student.id, status: 'PENDING' },
      select: { id: true },
    });
    if (open) {
      throw new ConflictException({
        code: 'PENDING_REQUEST_EXISTS',
        message: 'You already have a request waiting to be picked up.',
      });
    }

    const checkIn = dto.checkInId
      ? await this.requireOwnCheckIn(student.id, dto.checkInId)
      : await this.prisma.emotionalCheckIn.findFirst({
          where: { studentId: student.id },
          orderBy: { createdAt: 'desc' },
        });

    const note = dto.note?.trim() || null;
    const entry = await this.composeEntry(student.firstName, student.classLabel, checkIn, note);

    const thread = await this.prisma.chatThread.create({
      data: {
        schoolId: user.schoolId,
        studentId: student.id,
        entryCheckInId: checkIn?.id ?? null,
        aiEntrySummary: entry.text,
        studentReadAt: new Date(),
        messages: {
          create: [
            {
              role: 'SYSTEM',
              content: entry.text,
              meta: { composedByAi: entry.viaAi },
            },
            ...(note
              ? [{ role: 'STUDENT' as const, senderUserId: userId, content: note }]
              : []),
          ],
        },
      },
      // Nested inserts share a timestamp; enum order puts SYSTEM before STUDENT.
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { role: 'desc' }, { id: 'asc' }] } },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'chat.thread_created',
      entity: 'ChatThread',
      entityId: thread.id,
      meta: {
        studentId: student.id,
        checkInId: checkIn?.id ?? null,
        composedByAi: entry.viaAi,
      },
      schoolId: thread.schoolId,
    });

    const professionals = await this.prisma.user.findMany({
      where: {
        schoolId: user.schoolId,
        role: { in: [...STAFF_ROLES] },
        deactivatedAt: null,
      },
      select: { id: true },
    });
    const pendingCount = await this.prisma.chatThread.count({
      where: { schoolId: user.schoolId, status: 'PENDING' },
    });
    this.realtime.emitToSchoolProfessionals(
      user.schoolId,
      REALTIME_EVENTS.CHAT_REQUEST_CREATED,
      {
        threadId: thread.id,
        student: { firstName: student.firstName, classLabel: student.classLabel },
        pendingCount,
      },
    );
    for (const professional of professionals) {
      await this.notifications.push({
        userId: professional.id,
        type: 'CHAT_REQUEST',
        title: `${student.firstName} asked to talk`,
        body: entry.text,
        data: { threadId: thread.id },
      });
    }

    return thread;
  }

  /** Students see their own threads; staff see the ones they claimed. */
  async listThreads(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    if ((STAFF_ROLES as readonly string[]).includes(user.role)) {
      const professional = await this.prisma.professionalProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!professional) return { items: [] };
      const items = await this.prisma.chatThread.findMany({
        where: { professionalId: professional.id },
        orderBy: { updatedAt: 'desc' },
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              classLabel: true,
              studentCode: true,
            },
          },
          messages: {
            orderBy: [{ createdAt: 'desc' }, { role: 'asc' }, { id: 'desc' }],
            take: 1,
            select: { content: true, role: true, createdAt: true },
          },
        },
      });
      return { items };
    }

    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.chatThread.findMany({
      where: { studentId: student.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        professional: {
          select: {
            title: true,
            department: true,
            user: { select: { name: true } },
          },
        },
        messages: {
          orderBy: [{ createdAt: 'desc' }, { role: 'asc' }, { id: 'desc' }],
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
      },
    });
    return { items };
  }

  /** The shared pool: PENDING requests of my school, oldest first. */
  async inbox(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { schoolId: true },
    });
    if (!user?.schoolId) return { items: [] };

    const items = await this.prisma.chatThread.findMany({
      where: { schoolId: user.schoolId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        student: {
          select: {
            firstName: true,
            lastName: true,
            classLabel: true,
            studentCode: true,
          },
        },
        messages: {
          where: { role: 'STUDENT' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
      },
    });
    return { items };
  }

  async claim(userId: string, threadId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, schoolId: true },
    });
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        schoolId: true,
        student: { select: { userId: true } },
      },
    });
    // Cross-school requests are indistinguishable from missing ones.
    if (!thread || !user?.schoolId || thread.schoolId !== user.schoolId) {
      throw new NotFoundException('Chat thread not found');
    }

    const professional = await this.prisma.professionalProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!professional) throw new NotFoundException('Professional profile not found');

    // Race-safe claim: only the first PENDING→ACTIVE update wins.
    const now = new Date();
    const claimed = await this.prisma.chatThread.updateMany({
      where: { id: threadId, status: 'PENDING' },
      data: {
        professionalId: professional.id,
        status: 'ACTIVE',
        professionalReadAt: now,
        claimedAt: now,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: 'CHAT_THREAD_TAKEN',
        message: 'Another professional has already picked up this request.',
      });
    }

    await this.auditService.log({
      actorId: userId,
      action: 'chat.thread_claimed',
      entity: 'ChatThread',
      entityId: threadId,
      meta: { professionalId: professional.id },
      schoolId: thread.schoolId,
    });

    const payload = { threadId, professionalName: user.name };
    this.realtime.emitToUser(
      thread.student.userId,
      REALTIME_EVENTS.CHAT_THREAD_CLAIMED,
      payload,
    );
    this.realtime.emitToSchoolProfessionals(
      thread.schoolId,
      REALTIME_EVENTS.CHAT_THREAD_CLAIMED,
      payload,
    );
    await this.notifications.push({
      userId: thread.student.userId,
      type: 'CHAT_CLAIMED',
      title: `${user.name} picked up your request`,
      body: 'Your chat is open — say hello when you are ready.',
      data: { threadId },
    });

    return this.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: {
        student: {
          select: {
            firstName: true,
            lastName: true,
            classLabel: true,
            studentCode: true,
          },
        },
        professional: {
          select: {
            title: true,
            department: true,
            user: { select: { name: true } },
          },
        },
      },
    });
  }

  /**
   * Staff-accept lane: a counsellor marking a support request ACCEPTED opens
   * an ACTIVE thread with the student straight away — no PENDING pool stop.
   * Idempotent: an existing ACTIVE thread between the same professional and
   * student is reused, never duplicated.
   */
  async openDirectThread(
    professionalUserId: string,
    input: { studentProfileId: string; schoolId: string; summary: string },
  ): Promise<{ id: string; created: boolean }> {
    const professional = await this.prisma.professionalProfile.findUnique({
      where: { userId: professionalUserId },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!professional) {
      throw new NotFoundException('Professional profile not found');
    }
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: input.studentProfileId },
      select: { userId: true },
    });
    if (!student) throw new NotFoundException('Student profile not found');

    const existing = await this.prisma.chatThread.findFirst({
      where: {
        studentId: input.studentProfileId,
        professionalId: professional.id,
        status: 'ACTIVE',
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { id: existing.id, created: false };

    const now = new Date();
    const thread = await this.prisma.chatThread.create({
      data: {
        schoolId: input.schoolId,
        studentId: input.studentProfileId,
        professionalId: professional.id,
        status: 'ACTIVE',
        claimedAt: now,
        professionalReadAt: now,
        studentReadAt: now,
        aiEntrySummary: input.summary,
        messages: {
          create: {
            role: 'SYSTEM',
            content: input.summary,
            meta: { source: 'support_request_accept' },
          },
        },
      },
    });

    await this.auditService.log({
      actorId: professionalUserId,
      action: 'chat.thread_opened_from_request',
      entity: 'ChatThread',
      entityId: thread.id,
      meta: { studentId: input.studentProfileId },
      schoolId: input.schoolId,
    });

    const payload = {
      threadId: thread.id,
      professionalName: professional.user.name,
    };
    this.realtime.emitToUser(
      student.userId,
      REALTIME_EVENTS.CHAT_THREAD_CLAIMED,
      payload,
    );
    await this.notifications.push({
      userId: student.userId,
      type: 'CHAT_CLAIMED',
      title: `${professional.user.name} is here to talk with you`,
      body: input.summary,
      data: { threadId: thread.id },
    });
    await this.emitUnread(student.userId);

    return { id: thread.id, created: true };
  }

  async sendMessage(userId: string, threadId: string, dto: SendChatMessageDto) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        status: true,
        student: { select: { userId: true, firstName: true } },
        professional: {
          select: { userId: true, user: { select: { name: true } } },
        },
      },
    });
    if (!thread) throw new NotFoundException('Chat thread not found');
    const senderRole = this.participantRole(thread, userId);

    if (thread.status === 'CLOSED') {
      throw new ConflictException({
        code: 'CHAT_THREAD_CLOSED',
        message: 'This chat has been closed.',
      });
    }
    if (thread.status !== 'ACTIVE' || !thread.professional) {
      throw new ConflictException({
        code: 'CHAT_NOT_CLAIMED',
        message: 'This request has not been picked up yet.',
      });
    }

    this.assertMessageRate(userId);

    const now = new Date();
    const message = await this.prisma.chatMessage.create({
      data: {
        threadId,
        senderUserId: userId,
        role: senderRole,
        content: dto.content,
        viaVoice: dto.viaVoice ?? false,
      },
    });
    await this.prisma.chatThread.update({
      where: { id: threadId },
      data:
        senderRole === 'STUDENT'
          ? { studentReadAt: now }
          : { professionalReadAt: now },
    });

    const payload = {
      threadId,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        viaVoice: message.viaVoice,
        createdAt: message.createdAt,
      },
    };
    this.realtime.emitToUser(
      thread.student.userId,
      REALTIME_EVENTS.CHAT_MESSAGE_NEW,
      payload,
    );
    this.realtime.emitToUser(
      thread.professional.userId,
      REALTIME_EVENTS.CHAT_MESSAGE_NEW,
      payload,
    );

    const recipientUserId =
      senderRole === 'STUDENT'
        ? thread.professional.userId
        : thread.student.userId;
    const senderName =
      senderRole === 'STUDENT'
        ? thread.student.firstName
        : thread.professional.user.name;
    await this.notifications.push({
      userId: recipientUserId,
      type: 'CHAT_REPLY',
      title: `${senderName} replied`,
      body: preview(dto.content),
      data: { threadId },
    });
    await this.emitUnread(recipientUserId);

    return message;
  }

  async readThread(userId: string, threadId: string) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        student: { select: { userId: true } },
        professional: { select: { userId: true } },
      },
    });
    if (!thread) throw new NotFoundException('Chat thread not found');
    const role = this.participantRole(thread, userId);

    await this.prisma.chatThread.update({
      where: { id: threadId },
      data:
        role === 'STUDENT'
          ? { studentReadAt: new Date() }
          : { professionalReadAt: new Date() },
    });
    await this.emitUnread(userId);
    return { id: threadId, read: true };
  }

  async getThread(userId: string, threadId: string) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: {
        student: {
          select: {
            userId: true,
            firstName: true,
            lastName: true,
            classLabel: true,
            studentCode: true,
          },
        },
        professional: {
          select: {
            userId: true,
            title: true,
            department: true,
            user: { select: { name: true } },
          },
        },
        messages: { orderBy: [{ createdAt: 'asc' }, { role: 'desc' }, { id: 'asc' }] },
      },
    });
    if (!thread) throw new NotFoundException('Chat thread not found');
    this.participantRole(thread, userId);
    return thread;
  }

  async close(userId: string, threadId: string) {
    const thread = await this.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        id: true,
        status: true,
        schoolId: true,
        student: { select: { userId: true } },
        professional: { select: { userId: true } },
      },
    });
    if (!thread) throw new NotFoundException('Chat thread not found');
    this.participantRole(thread, userId);

    if (thread.status === 'CLOSED') return { id: threadId, status: 'CLOSED' };

    await this.prisma.chatThread.update({
      where: { id: threadId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    await this.auditService.log({
      actorId: userId,
      action: 'chat.thread_closed',
      entity: 'ChatThread',
      entityId: threadId,
      schoolId: thread.schoolId,
    });

    const payload = { threadId };
    this.realtime.emitToUser(
      thread.student.userId,
      REALTIME_EVENTS.CHAT_THREAD_CLOSED,
      payload,
    );
    if (thread.professional) {
      this.realtime.emitToUser(
        thread.professional.userId,
        REALTIME_EVENTS.CHAT_THREAD_CLOSED,
        payload,
      );
    }
    return { id: threadId, status: 'CLOSED' };
  }

  /**
   * True unread counts (the 99+ display cap is client-side): messages newer
   * than my read marker, excluding my own sends and SYSTEM rows. Threads
   * with zero unread are omitted from `byThread` — clients read missing as 0.
   */
  async unreadSummary(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        studentProfile: { select: { id: true } },
        professionalProfile: { select: { id: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const isStaff = (STAFF_ROLES as readonly string[]).includes(user.role);
    const professionalId = isStaff ? user.professionalProfile?.id : undefined;
    const studentId = isStaff ? undefined : user.studentProfile?.id;

    let threads: { id: string; readAt: Date | null }[] = [];
    if (professionalId) {
      threads = (
        await this.prisma.chatThread.findMany({
          where: { professionalId },
          select: { id: true, professionalReadAt: true },
        })
      ).map((thread) => ({ id: thread.id, readAt: thread.professionalReadAt }));
    } else if (studentId) {
      threads = (
        await this.prisma.chatThread.findMany({
          where: { studentId },
          select: { id: true, studentReadAt: true },
        })
      ).map((thread) => ({ id: thread.id, readAt: thread.studentReadAt }));
    }

    const byThread: Record<string, number> = {};
    let total = 0;
    for (const thread of threads) {
      const count = await this.prisma.chatMessage.count({
        where: {
          threadId: thread.id,
          senderUserId: { not: userId },
          ...(thread.readAt ? { createdAt: { gt: thread.readAt } } : {}),
        },
      });
      if (count > 0) {
        byThread[thread.id] = count;
        total += count;
      }
    }
    return { total, byThread };
  }

  /**
   * Fixed-window per-user throttle. Peek before commit, like the guardrail
   * lane: a rejected message consumes no budget, so a user retrying during
   * the cool-down can never lock themselves out for the rest of the minute.
   */
  private assertMessageRate(userId: string, now: Date = new Date()): void {
    const limit = chatRateLimitPerMinute();
    const nowMs = now.getTime();
    this.pruneExpiredWindows(nowMs);

    const minuteStart = Math.floor(nowMs / 60_000) * 60_000;
    const key = `${userId}:${minuteStart}`;
    const count = (this.messageWindows.get(key)?.count ?? 0) + 1;
    if (count > limit) {
      throw new RateLimitExceededException(
        'You are sending messages too quickly. Please wait a moment.',
        60 - now.getSeconds(),
      );
    }
    this.messageWindows.set(key, {
      count,
      expiresAt: minuteStart + 2 * 60_000,
    });
  }

  private pruneExpiredWindows(nowMs: number): void {
    for (const [key, counter] of this.messageWindows) {
      if (counter.expiresAt <= nowMs) this.messageWindows.delete(key);
    }
  }

  private participantRole(
    thread: {
      student: { userId: string };
      professional: { userId: string } | null;
    },
    userId: string,
  ): 'STUDENT' | 'PROFESSIONAL' {
    if (thread.student.userId === userId) return 'STUDENT';
    if (thread.professional?.userId === userId) return 'PROFESSIONAL';
    throw new NotFoundException('Chat thread not found');
  }

  private async requireOwnCheckIn(studentId: string, checkInId: string) {
    const checkIn = await this.prisma.emotionalCheckIn.findFirst({
      where: { id: checkInId, studentId },
    });
    if (!checkIn) throw new NotFoundException('Check-in not found');
    return checkIn;
  }

  private async composeEntry(
    firstName: string,
    classLabel: string | null,
    checkIn: EmotionalCheckIn | null,
    note: string | null,
  ): Promise<{ text: string; viaAi: boolean }> {
    try {
      const text = await this.aiService.composeHandoffEntry({
        firstName,
        classLabel,
        feelingLabel: checkIn?.feeling ?? null,
        intensity: checkIn?.intensity ?? null,
        triggers: checkIn?.triggers ?? [],
        note,
      });
      return { text, viaAi: true };
    } catch {
      // AI is an enhancement here, never a dependency: a down provider must
      // not delay or fail a student's request for help.
      return {
        text: fallbackEntryNote({ firstName, classLabel, checkIn }),
        viaAi: false,
      };
    }
  }

  private async emitUnread(userId: string) {
    const summary = await this.unreadSummary(userId);
    this.realtime.emitToUser(
      userId,
      REALTIME_EVENTS.CHAT_UNREAD_UPDATED,
      summary,
    );
  }
}
