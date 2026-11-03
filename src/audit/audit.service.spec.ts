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
        schoolId: null,
        priorStatus: null,
        newStatus: null,
        ruleId: null,
        ruleVersion: null,
      },
    });
  });

  it('records a transition and its rule as stated facts, not implications', async () => {
    // US-D03: an audit row has to answer "what state did it leave, what did it
    // enter, under which rule version" without anyone re-deriving it.
    prisma.auditLog.create.mockResolvedValue({ id: 'log-prov' });
    await service.log({
      actorId: 'counsellor-1',
      action: 'support_flag.in_review',
      entity: 'SupportFlag',
      entityId: 'f1',
      priorStatus: 'OPEN',
      newStatus: 'IN_REVIEW',
      ruleId: 'IND-B01',
      ruleVersion: '1',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'counsellor-1',
        action: 'support_flag.in_review',
        entity: 'SupportFlag',
        entityId: 'f1',
        meta: undefined,
        schoolId: null,
        priorStatus: 'OPEN',
        newStatus: 'IN_REVIEW',
        ruleId: 'IND-B01',
        ruleVersion: '1',
      },
    });
  });

  it('logs the school scope when provided', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'log-2' });
    await service.log({
      actorId: 'admin-1',
      action: 'school.student_enrolled',
      entity: 'User',
      entityId: 'user-2',
      schoolId: 'school-1',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-1',
        action: 'school.student_enrolled',
        entity: 'User',
        entityId: 'user-2',
        meta: undefined,
        schoolId: 'school-1',
        priorStatus: null,
        newStatus: null,
        ruleId: null,
        ruleVersion: null,
      },
    });
  });

  it('lists recent audit events with a take cap', async () => {
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
    const result = await service.list({ take: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    expect(result).toHaveLength(1);
  });

  it('filters by actions and school scope', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    await service.list({
      take: 5,
      actions: ['chat.thread_created', 'chat.thread_claimed'],
      schoolId: 'school-9',
    });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        action: { in: ['chat.thread_created', 'chat.thread_claimed'] },
        schoolId: 'school-9',
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  });

  it('ignores an empty action filter', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);
    await service.list({ actions: [] });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });
});
