import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupportFlagStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupportFlagsService } from './support-flags.service.js';

const SCHOOL = { student: { user: { schoolId: 'school-1' } } };

describe('SupportFlagsService', () => {
  let service: SupportFlagsService;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ schoolId: 'school-1' }) },
      supportFlag: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    audit = { log: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportFlagsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(SupportFlagsService);
  });

  it("lists the actor school's flags and counts open ones school-wide", async () => {
    prisma.supportFlag.findMany.mockResolvedValue([{ id: 'f1' }]);
    prisma.supportFlag.count.mockResolvedValue(2);

    const result = await service.list('user-1', {
      severity: 'TIER_2_HIGH',
      status: 'OPEN',
    });

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith({
      where: { ...SCHOOL, severity: 'TIER_2_HIGH', status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(prisma.supportFlag.count).toHaveBeenCalledWith({
      where: {
        ...SCHOOL,
        status: { in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW] },
      },
    });
    expect(result.openCount).toBe(2);
  });

  it('lists every school flag when no filter is set, still tenant-scoped', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);

    await service.list('user-1', {});

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...SCHOOL } }),
    );
  });

  it('shows nothing and queries no tenant data for an actor without a school', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    const result = await service.list('orphan-1', {});

    expect(result).toEqual({ items: [], openCount: 0 });
    expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    expect(prisma.supportFlag.count).not.toHaveBeenCalled();
  });

  it('acknowledges a flag the school owns and audits the action', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue({ id: 'f1' });
    prisma.supportFlag.update.mockResolvedValue({
      id: 'f1',
      status: SupportFlagStatus.ACKNOWLEDGED,
    });

    const result = await service.acknowledge('user-1', 'f1');

    expect(prisma.supportFlag.findFirst).toHaveBeenCalledWith({
      where: { id: 'f1', ...SCHOOL },
      select: { id: true },
    });
    expect(prisma.supportFlag.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: SupportFlagStatus.ACKNOWLEDGED },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_flag.acknowledged' }),
    );
    expect(result.message).toBe('Flag acknowledged');
  });

  it('marks a flag in-review and audits the action', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue({ id: 'f1' });
    prisma.supportFlag.update.mockResolvedValue({
      id: 'f1',
      status: SupportFlagStatus.IN_REVIEW,
    });

    const result = await service.markInReview('user-1', 'f1');

    expect(prisma.supportFlag.findFirst).toHaveBeenCalledWith({
      where: { id: 'f1', ...SCHOOL },
      select: { id: true },
    });
    expect(prisma.supportFlag.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: SupportFlagStatus.IN_REVIEW },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_flag.in_review' }),
    );
    expect(result.message).toBe('Flag marked in-review');
  });

  it('throws NotFoundException for an unknown flag', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    await expect(service.acknowledge('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it("refuses to touch another school's flag without confirming it exists", async () => {
    // Tenant-scoped lookup finds nothing for a foreign id, so the caller
    // cannot tell a rival school's flag apart from a row that never was.
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    prisma.supportFlag.findUnique.mockResolvedValue({ id: 'f9', schoolId: 'other' });

    await expect(service.markInReview('user-1', 'f9')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.supportFlag.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses flag writes for an actor without a school', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    await expect(service.acknowledge('orphan-1', 'f1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.supportFlag.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportFlag.update).not.toHaveBeenCalled();
  });
});
