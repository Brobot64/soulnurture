import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminService } from './admin.service.js';

describe('AdminService', () => {
  let service: AdminService;
  const prisma = {
    school: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn(), count: vi.fn() },
    session: { deleteMany: vi.fn() },
    notification: { createMany: vi.fn() },
    chatThread: { count: vi.fn() },
    $transaction: vi.fn(),
  };
  const auditService = { log: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
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
    it('suspends, revokes every school session, notifies users, audits', async () => {
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1', status: 'ACTIVE' });
      prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      prisma.$transaction.mockResolvedValue([]);

      const result = await service.suspendSchool('admin-1', 'school-1');

      expect(result).toEqual({ id: 'school-1', status: 'SUSPENDED' });
      expect(prisma.school.update).toHaveBeenCalledWith({
        where: { id: 'school-1' },
        data: { status: 'SUSPENDED' },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { user: { schoolId: 'school-1' } },
      });
      const notifyArgs = prisma.notification.createMany.mock.calls[0][0];
      expect(notifyArgs.data).toHaveLength(2);
      expect(notifyArgs.data[0]).toMatchObject({
        userId: 'u1',
        type: 'SCHOOL_SUSPENDED',
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'school.suspended', entityId: 'school-1' }),
      );
    });

    it('is idempotent for an already-suspended school', async () => {
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1', status: 'SUSPENDED' });

      await service.suspendSchool('admin-1', 'school-1');

      expect(prisma.school.update).not.toHaveBeenCalled();
      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
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

  describe('listUsers', () => {
    it('caps take at 100', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.listUsers('500');

      expect(prisma.user.findMany.mock.calls[0][0].take).toBe(100);
    });
  });
});
