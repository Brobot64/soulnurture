import { Test, TestingModule } from '@nestjs/testing';
import {
  SupportFlagStatus,
  SupportRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { DashboardService } from './dashboard.service.js';

const SCHOOL = { student: { user: { schoolId: 'school-1' } } };

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ schoolId: 'school-1' }) },
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
      expect.objectContaining({
        where: {
          ...SCHOOL,
          status: {
            in: [
              SupportFlagStatus.OPEN,
              SupportFlagStatus.IN_REVIEW,
              SupportFlagStatus.ACKNOWLEDGED,
            ],
          },
        },
        take: 20,
      }),
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

  it('counts escalated flags for the school only', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    expect(prisma.supportFlag.count).toHaveBeenCalledWith({
      where: { ...SCHOOL, status: SupportFlagStatus.OPEN },
    });
  });

  it('builds the barometer from the school check-ins only', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    expect(prisma.emotionalCheckIn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...SCHOOL } }),
    );
  });

  it('filters the request queue to the school and to pending + escalated', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...SCHOOL,
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

  it('returns an empty portal and queries no tenant data for a school-less actor', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    const result = await service.counsellor('orphan-1');

    expect(result).toEqual({
      flags: [],
      barometer: expect.objectContaining({ total: 0 }),
      supportRequests: [],
      escalatedFlagCount: 0,
      upcomingDropIn: null,
    });
    expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    expect(prisma.emotionalCheckIn.findMany).not.toHaveBeenCalled();
    expect(prisma.supportRequest.findMany).not.toHaveBeenCalled();
  });
});
