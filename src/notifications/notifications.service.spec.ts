import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_EVENTS } from '../realtime/realtime.events.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { NotificationsService } from './notifications.service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    userId: 'u1',
    type: 'SCHOOL_SUSPENDED',
    title: 'Title',
    body: null,
    data: null,
    readAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => error as HttpException,
  );
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  const prisma = {
    notification: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const realtime = { emitToUser: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  describe('push', () => {
    it('persists the row, then emits notification.new followed by the fresh count', async () => {
      const order: string[] = [];
      prisma.notification.create.mockImplementation(async () => {
        order.push('create');
        return row();
      });
      prisma.notification.count.mockImplementation(async () => {
        order.push('count');
        return 4;
      });
      realtime.emitToUser.mockImplementation((_userId, event: string) => {
        order.push(event);
      });

      const created = await service.push({
        userId: 'u1',
        type: 'CHAT_MESSAGE',
        title: 'New message',
        body: 'Hello',
        data: { threadId: 't1' },
      });

      expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
        userId: 'u1',
        type: 'CHAT_MESSAGE',
        title: 'New message',
        body: 'Hello',
        data: { threadId: 't1' },
      });
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u1',
        REALTIME_EVENTS.NOTIFICATION_NEW,
        {
          id: 'n1',
          type: 'SCHOOL_SUSPENDED',
          title: 'Title',
          body: null,
          data: null,
        },
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u1',
        REALTIME_EVENTS.NOTIFICATION_UNREAD_UPDATED,
        { count: 4 },
      );
      expect(order).toEqual([
        'create',
        REALTIME_EVENTS.NOTIFICATION_NEW,
        'count',
        REALTIME_EVENTS.NOTIFICATION_UNREAD_UPDATED,
      ]);
      expect(created.id).toBe('n1');
    });
  });

  describe('pushMany', () => {
    it('creates every row in one transaction and emits per row, skipping counts', async () => {
      prisma.$transaction.mockResolvedValue([
        row({ id: 'n-u1', userId: 'u1' }),
        row({ id: 'n-u2', userId: 'u2' }),
      ]);

      const rows = await service.pushMany({
        userIds: ['u1', 'u2'],
        type: 'SCHOOL_SUSPENDED',
        title: 'Paused',
        body: 'Your school is currently suspended.',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.notification.create).toHaveBeenCalledTimes(2);
      expect(prisma.notification.create.mock.calls[0][0].data).toMatchObject({
        userId: 'u1',
        type: 'SCHOOL_SUSPENDED',
        title: 'Paused',
        body: 'Your school is currently suspended.',
      });
      expect(rows).toHaveLength(2);
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u1',
        REALTIME_EVENTS.NOTIFICATION_NEW,
        expect.objectContaining({ id: 'n-u1' }),
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u2',
        REALTIME_EVENTS.NOTIFICATION_NEW,
        expect.objectContaining({ id: 'n-u2' }),
      );
      expect(prisma.notification.count).not.toHaveBeenCalled();
    });

    it('short-circuits an empty id list', async () => {
      const rows = await service.pushMany({
        userIds: [],
        type: 'SCHOOL_SUSPENDED',
        title: 'Paused',
      });

      expect(rows).toEqual([]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.emitToUser).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists newest-first capped at 50 and filters to unread when asked', async () => {
      prisma.notification.findMany.mockResolvedValue([row()]);

      await service.list('u1');
      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      await service.list('u1', { unreadOnly: true });
      expect(prisma.notification.findMany.mock.calls[1][0].where).toEqual({
        userId: 'u1',
        readAt: null,
      });
    });
  });

  describe('unreadCount', () => {
    it('reports the true unread count', async () => {
      prisma.notification.count.mockResolvedValue(7);

      await expect(service.unreadCount('u1')).resolves.toEqual({ count: 7 });
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'u1', readAt: null },
      });
    });
  });

  describe('markRead', () => {
    it('marks unread rows read and pushes the fresh count', async () => {
      prisma.notification.findFirst.mockResolvedValue({ id: 'n1', readAt: null });
      prisma.notification.update.mockResolvedValue(row());
      prisma.notification.count.mockResolvedValue(2);

      const result = await service.markRead('u1', 'n1');

      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'u1' },
        select: { id: true, readAt: true },
      });
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { readAt: expect.any(Date) },
      });
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u1',
        REALTIME_EVENTS.NOTIFICATION_UNREAD_UPDATED,
        { count: 2 },
      );
      expect(result).toEqual({ id: 'n1', read: true });
    });

    it('is a silent no-op for already-read rows', async () => {
      prisma.notification.findFirst.mockResolvedValue({ id: 'n1', readAt: new Date() });

      await service.markRead('u1', 'n1');

      expect(prisma.notification.update).not.toHaveBeenCalled();
      expect(realtime.emitToUser).not.toHaveBeenCalled();
    });

    it('404s for rows that are not the caller\u2019s', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);

      const rejection = await rejectionOf(service.markRead('u1', 'n-other'));

      expect(rejection?.getStatus()).toBe(404);
    });
  });

  describe('markAllRead', () => {
    it('marks all unread rows read and pushes the count', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 3 });
      prisma.notification.count.mockResolvedValue(0);

      const result = await service.markAllRead('u1');

      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u1',
        REALTIME_EVENTS.NOTIFICATION_UNREAD_UPDATED,
        { count: 0 },
      );
      expect(result).toEqual({ readAll: true });
    });
  });
});
