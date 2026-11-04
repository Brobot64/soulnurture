import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let service: AuditService;
  const prisma = {
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AuditService);
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });
    prisma.auditLog.create.mockResolvedValue({ id: 'log-any' });
  });

  it('logs an audit entry', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'log-1' });
    prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-7' });
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
        schoolId: 'school-7',
        priorStatus: null,
        newStatus: null,
        ruleId: null,
        ruleVersion: null,
      },
    });
  });

  it('puts an event with no actor on no school', async () => {
    // The AI worker's own events name nobody, so there is nothing to derive
    // from: they stay platform-level and out of every school's trail.
    prisma.auditLog.create.mockResolvedValue({ id: 'log-noactor' });
    await service.log({
      action: 'ai_generation.exhausted',
      entity: 'AiJob',
      entityId: 'job-1',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ schoolId: null }) }),
    );
  });

  it('keeps the school the caller named, even beside an actor', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'log-explicit' });
    prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-7' });
    await service.log({
      actorId: 'counsellor-1',
      action: 'support_flag.auto_created',
      entity: 'SupportFlag',
      entityId: 'f9',
      schoolId: 'school-3',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ schoolId: 'school-3' }),
      }),
    );
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

  it('lists only the reviewer’s own school, newest first', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-4' });
    prisma.auditLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
    const result = await service.list('counsellor-1', { take: 10 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-4' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    expect(result).toHaveLength(1);
  });

  it('narrows within that school by action', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-9' });
    prisma.auditLog.findMany.mockResolvedValue([]);
    await service.list('counsellor-9', {
      take: 5,
      actions: ['chat.thread_created', 'chat.thread_claimed'],
    });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        schoolId: 'school-9',
        action: { in: ['chat.thread_created', 'chat.thread_claimed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
  });

  it('ignores an empty action filter', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-4' });
    prisma.auditLog.findMany.mockResolvedValue([]);
    await service.list('counsellor-1', { actions: [] });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-4' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('refuses a reviewer whose account is on no school', async () => {
    // PE-15 is the fail-closed half of the fix: an unscoped read is the leak,
    // so there is no "show everything" fallback for a misprovisioned account.
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });
    await expect(service.list('orphan-counsellor')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
