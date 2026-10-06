import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let service: AuditService;
  const prisma = { auditLog: { create: vi.fn(), findMany: vi.fn() } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AuditService);
  });

  it('logs an audit entry', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'log-1' });
    await service.log({
      actorId: 'user-1',
      action: 'support_request.created',
      entity: 'SupportRequest',
      entityId: 'req-1',
      meta: { timing: 'ASAP' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'user-1',
        action: 'support_request.created',
        entity: 'SupportRequest',
        entityId: 'req-1',
        meta: { timing: 'ASAP' },
      },
    });
  });

  it('lists recent audit events with a take cap', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
    const result = await service.list({ take: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    expect(result).toHaveLength(1);
  });
});