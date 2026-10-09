import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_EVENTS } from '../realtime/realtime.events.js';
import { RealtimeService } from '../realtime/realtime.service.js';

const LIST_TAKE = 50;

interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  data: Prisma.JsonValue;
}

export interface PushNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
}

export interface PushManyNotificationInput {
  userIds: string[];
  type: string;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
}

function toEventPayload(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data,
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /// The single sanctioned creator: persists the row first, then pushes
  /// `notification.new` plus the owner's fresh unread count (true counts —
  /// the 99+ display cap lives client-side).
  async push(input: PushNotificationInput) {
    const row = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data,
      },
    });
    this.realtime.emitToUser(
      input.userId,
      REALTIME_EVENTS.NOTIFICATION_NEW,
      toEventPayload(row),
    );
    await this.emitUnreadCount(input.userId);
    return row;
  }

  /// Bulk variant for school-wide events (suspension). Rows are created in
  /// one transaction so every `notification.new` carries the real row id;
  /// the unread-count emit is skipped on purpose — suspension is about to
  /// disconnect these sockets, and clients refetch counts on reconnect.
  async pushMany(input: PushManyNotificationInput) {
    if (input.userIds.length === 0) return [];
    const rows = await this.prisma.$transaction(
      input.userIds.map((userId) =>
        this.prisma.notification.create({
          data: {
            userId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            data: input.data,
          },
        }),
      ),
    );
    for (const row of rows) {
      this.realtime.emitToUser(
        row.userId,
        REALTIME_EVENTS.NOTIFICATION_NEW,
        toEventPayload(row),
      );
    }
    return rows;
  }

  async list(userId: string, options: { unreadOnly?: boolean } = {}) {
    const items = await this.prisma.notification.findMany({
      where: {
        userId,
        ...(options.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_TAKE,
    });
    return { items };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    const row = await this.prisma.notification.findFirst({
      where: { id, userId },
      select: { id: true, readAt: true },
    });
    if (!row) throw new NotFoundException('Notification not found');
    if (!row.readAt) {
      await this.prisma.notification.update({
        where: { id },
        data: { readAt: new Date() },
      });
      await this.emitUnreadCount(userId);
    }
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    await this.emitUnreadCount(userId);
    return { readAll: true };
  }

  private async emitUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    this.realtime.emitToUser(
      userId,
      REALTIME_EVENTS.NOTIFICATION_UNREAD_UPDATED,
      { count },
    );
  }
}
