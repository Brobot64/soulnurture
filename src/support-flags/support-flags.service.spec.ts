import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupportFlagStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupportFlagsService } from './support-flags.service.js';

describe('SupportFlagsService', () => {
  let service: SupportFlagsService;
  let prisma: {
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      supportFlag: {
        findMany: vi.fn(),
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

  it('lists flags filtered by severity/status and counts open ones', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([{ id: 'f1' }]);
    prisma.supportFlag.count.mockResolvedValue(2);

    const result = await service.list('user-1', {
      severity: 'TIER_2_HIGH',
      status: 'OPEN',
    });

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith({
      where: { severity: 'TIER_2_HIGH', status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(prisma.supportFlag.count).toHaveBeenCalledWith({
      where: {
        status: { in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW] },
      },
    });
    expect(result.openCount).toBe(2);
  });

  it('acknowledges a flag and audits the action', async () => {
    prisma.supportFlag.findUnique.mockResolvedValue({ id: 'f1' });
    prisma.supportFlag.update.mockResolvedValue({
      id: 'f1',
      status: SupportFlagStatus.ACKNOWLEDGED,
    });

    const result = await service.acknowledge('user-1', 'f1');

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
    prisma.supportFlag.findUnique.mockResolvedValue({ id: 'f1' });
    prisma.supportFlag.update.mockResolvedValue({
      id: 'f1',
      status: SupportFlagStatus.IN_REVIEW,
    });

    const result = await service.markInReview('user-1', 'f1');

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
    prisma.supportFlag.findUnique.mockResolvedValue(null);
    await expect(service.acknowledge('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});