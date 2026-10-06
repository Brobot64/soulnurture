import { Test, TestingModule } from '@nestjs/testing';
import { SupportRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { DashboardService } from './dashboard.service.js';

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: {
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
  };

  beforeEach(async () => {
    prisma = {
      supportFlag: { findMany: vi.fn(), count: vi.fn() },
      emotionalCheckIn: { findMany: vi.fn() },
      supportRequest: { findMany: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(DashboardService);
  });

  it('loads active flags, request queue, and a barometer summary', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([{ id: 'f1' }]);
    prisma.supportFlag.count.mockResolvedValue(1);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([
      { feeling: 'OVERWHELMED' },
      { feeling: 'OVERWHELMED' },
      { feeling: 'CALM' },
    ]);
    prisma.supportRequest.findMany.mockResolvedValue([{ id: 'req-1' }]);

    const result = await service.counsellor('user-1');

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
    expect(result.flags).toEqual([{ id: 'f1' }]);
    expect(result.escalatedFlagCount).toBe(1);
    expect(result.barometer).toEqual({
      total: 3,
      dominant: 'OVERWHELMED',
      distribution: { OVERWHELMED: 2, CALM: 1 },
      notes: expect.any(String),
    });
    expect(result.supportRequests).toEqual([{ id: 'req-1' }]);
  });

  it('filters the request queue to pending + escalated', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: {
            in: [SupportRequestStatus.PENDING, SupportRequestStatus.ESCALATED],
          },
        },
      }),
    );
  });

  it('returns a graceful barometer when there are no check-ins', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    const result = await service.counsellor('user-1');

    expect(result.barometer.total).toBe(0);
    expect(result.barometer.dominant).toBeNull();
    expect(result.barometer.notes).toContain('No check-ins');
  });
});