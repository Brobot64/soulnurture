import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import { AdminService } from './admin.service.js';

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  const rejection = await promise.then(
    () => null,
    (error) => error as HttpException,
  );
  if (!rejection) throw new Error('Expected the call to reject');
  return rejection;
}

describe('AdminService', () => {
  let service: AdminService;
  const prisma = {
    school: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    session: { deleteMany: vi.fn() },
    chatThread: { count: vi.fn(), groupBy: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  };
  const auditService = { log: vi.fn() };
  const notifications = { pushMany: vi.fn() };
  const realtime = { disconnectUser: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
        { provide: NotificationsService, useValue: notifications },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get(AdminService);
  });

  describe('createSchool', () => {
    it('creates an ACTIVE school with a 6-char code and audits it', async () => {
      prisma.school.create.mockResolvedValue({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        status: 'ACTIVE',
      });

      const result = await service.createSchool('admin-1', { name: 'Achimota School' });

      const createArgs = prisma.school.create.mock.calls[0][0];
      expect(createArgs.data.name).toBe('Achimota School');
      expect(createArgs.data.shortCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
      expect(createArgs.data.defaultPasswordHash).toBeNull();
      expect(result).toEqual({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        status: 'ACTIVE',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: 'school.created',
          entity: 'School',
          entityId: 'school-1',
        }),
      );
    });

    it('stores a scrypt hash of the default password, never the plaintext', async () => {
      prisma.school.create.mockResolvedValue({
        id: 'school-1',
        name: 'Ridge',
        shortCode: 'RID234',
        status: 'ACTIVE',
      });

      await service.createSchool('admin-1', {
        name: 'Ridge',
        defaultPassword: 'welcome-1234',
      });

      const hash = prisma.school.create.mock.calls[0][0].data.defaultPasswordHash;
      expect(typeof hash).toBe('string');
      expect(hash).not.toContain('welcome-1234');
      expect(JSON.stringify(prisma.school.create.mock.calls)).not.toContain('welcome-1234');
    });

    it('retries on short-code unique conflicts', async () => {
      prisma.school.create
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce({
          id: 'school-2',
          name: 'Ridge',
          shortCode: 'RID234',
          status: 'ACTIVE',
        });

      const result = await service.createSchool('admin-1', { name: 'Ridge' });

      expect(prisma.school.create).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('school-2');
    });
  });

  describe('suspendSchool', () => {
    it('suspends, revokes every school session, notifies users, kills live sockets, audits', async () => {
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1', status: 'ACTIVE' });
      prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      prisma.$transaction.mockResolvedValue([]);
      notifications.pushMany.mockResolvedValue([]);

      const result = await service.suspendSchool('admin-1', 'school-1');

      expect(result).toEqual({ id: 'school-1', status: 'SUSPENDED' });
      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { id: 'school-1' },
        data: { status: 'SUSPENDED' },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { user: { schoolId: 'school-1' } },
      });
      expect(notifications.pushMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userIds: ['u1', 'u2'],
          type: 'SCHOOL_SUSPENDED',
        }),
      );
      expect(realtime.disconnectUser).toHaveBeenCalledTimes(2);
      expect(realtime.disconnectUser).toHaveBeenCalledWith('u1');
      expect(realtime.disconnectUser).toHaveBeenCalledWith('u2');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'school.suspended', entityId: 'school-1' }),
      );
    });

    it('is idempotent for an already-suspended school', async () => {
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1', status: 'SUSPENDED' });

      await service.suspendSchool('admin-1', 'school-1');

      expect(prisma.school.update).not.toHaveBeenCalled();
      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
      expect(notifications.pushMany).not.toHaveBeenCalled();
      expect(realtime.disconnectUser).not.toHaveBeenCalled();
    });
  });

  describe('overview', () => {
    it('aggregates school, user and chat counts', async () => {
      prisma.school.count
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1);
      prisma.user.count
        .mockResolvedValueOnce(120)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(15)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(40);
      prisma.chatThread.count.mockResolvedValue(7);

      const result = await service.overview();

      expect(result).toEqual({
        schools: { total: 4, active: 3, suspended: 1 },
        users: {
          total: 120,
          students: 100,
          professionals: 15,
          admins: 5,
          newLast7d: 10,
          newLast30d: 40,
        },
        chat: { pendingRequests: 7 },
      });
    });
  });

  describe('listSchools', () => {
    it('merges live gauges onto each school, defaulting zeros and null activity', async () => {
      const createdAt = new Date('2026-10-01T00:00:00Z');
      prisma.school.findMany.mockResolvedValue([
        {
          id: 'school-1',
          name: 'Achimota School',
          shortCode: 'AS2345',
          status: 'ACTIVE',
          createdAt,
          _count: { users: 10 },
        },
        {
          id: 'school-2',
          name: 'Ridge',
          shortCode: 'RID234',
          status: 'ACTIVE',
          createdAt,
          _count: { users: 0 },
        },
      ]);
      prisma.user.groupBy
        .mockResolvedValueOnce([{ schoolId: 'school-1', _count: { _all: 8 } }])
        .mockResolvedValueOnce([{ schoolId: 'school-1', _count: { _all: 2 } }]);
      prisma.chatThread.groupBy.mockResolvedValue([
        { schoolId: 'school-1', _count: { _all: 3 } },
      ]);
      const lastActivityAt = new Date('2026-10-09T08:00:00Z');
      prisma.$queryRaw.mockResolvedValue([
        { schoolId: 'school-1', lastActivityAt },
      ]);

      const result = await service.listSchools();

      expect(prisma.user.groupBy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          by: ['schoolId'],
          where: { schoolId: { not: null }, role: 'STUDENT' },
        }),
      );
      expect(prisma.user.groupBy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          by: ['schoolId'],
          where: { schoolId: { not: null }, role: { in: [...STAFF_ROLES] } },
        }),
      );
      expect(prisma.chatThread.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PENDING' },
        }),
      );
      expect(result.items[0]).toMatchObject({
        id: 'school-1',
        students: 8,
        professionals: 2,
        pendingChats: 3,
        lastActivityAt,
      });
      expect(result.items[1]).toMatchObject({
        id: 'school-2',
        students: 0,
        professionals: 0,
        pendingChats: 0,
        lastActivityAt: null,
      });
    });
  });

  describe('listUsers', () => {
    it('caps take at 100 and returns items with a total', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
      prisma.user.count.mockResolvedValue(120);

      const result = await service.listUsers({ limit: '500' });

      expect(prisma.user.findMany.mock.calls[0][0].take).toBe(100);
      expect(result).toEqual({ items: [{ id: 'u1' }], total: 120 });
    });

    it('applies role, school, search and offset filters to both queries', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers({
        role: 'STUDENT',
        schoolId: 'school-1',
        q: ' ama ',
        offset: '20',
        limit: '10',
      });

      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        role: 'STUDENT',
        schoolId: 'school-1',
        OR: [
          { name: { contains: 'ama', mode: 'insensitive' } },
          { email: { contains: 'ama', mode: 'insensitive' } },
        ],
      });
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(prisma.user.count).toHaveBeenCalledWith({ where: args.where });
      const selectKeys = Object.keys(args.select);
      expect(selectKeys).toEqual(
        expect.arrayContaining(['role', 'schoolId']),
      );
    });

    it('rejects an unknown role filter with 422', async () => {
      const rejection = await rejectionOf(service.listUsers({ role: 'PRINCIPAL' }));

      expect(rejection.getStatus()).toBe(422);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
