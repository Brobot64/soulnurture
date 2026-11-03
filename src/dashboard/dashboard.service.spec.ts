import { Test, TestingModule } from '@nestjs/testing';
import {
  SupportFlagStatus,
  SupportRequestStatus,
  SupportTiming,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { DashboardService } from './dashboard.service.js';

const SCHOOL = { student: { user: { schoolId: 'school-1' } } };

const AWAITING_WHERE = {
  ...SCHOOL,
  status: {
    in: [SupportRequestStatus.PENDING, SupportRequestStatus.ESCALATED],
  },
};

function requestRow(
  id: string,
  overrides: {
    status?: SupportRequestStatus;
    timing?: SupportTiming;
    createdAt?: Date;
    readAt?: Date | null;
  } = {},
) {
  return {
    id,
    status: overrides.status ?? SupportRequestStatus.PENDING,
    timing: overrides.timing ?? SupportTiming.GENTLE_1_2_DAYS,
    note: null,
    initialMessage: null,
    initialMessageAt: null,
    createdAt: overrides.createdAt ?? new Date('2026-10-30T09:00:00.000Z'),
    conversationId: null,
    reads: overrides.readAt ? [{ readAt: overrides.readAt }] : [],
    supportPerson: { id: 'p1', name: 'Mrs. Adebayo', type: 'COUNSELLOR' },
    student: {
      firstName: 'Ada',
      lastName: 'Eze',
      displayName: null,
      classLabel: 'SS2',
      studentCode: 'PNA-0001',
      studentRef: 'PNA-0001',
    },
  };
}

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
      supportRequest: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
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
    prisma.supportRequest.findMany.mockResolvedValue([requestRow('req-1')]);

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
    expect(result.openFlagCount).toBe(1);
    expect(result.barometer).toEqual({
      total: 3,
      dominant: 'OVERWHELMED',
      distribution: { OVERWHELMED: 2, CALM: 1 },
      notes: expect.any(String),
    });
    expect(result.supportRequests).toHaveLength(1);
    expect(result.supportRequests[0]).toEqual(
      expect.objectContaining({ id: 'req-1', urgency: 'NORMAL' }),
    );
  });

  it('sorts flags acute first, not by enum declaration order', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    // Postgres orders an enum by declaration, so 'asc' would lead with
    // TIER_1_MODERATE and push TIER_3_ACUTE past the preview cap.
    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  });

  it('surfaces an older escalated request ahead of a newer pending one', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([
      // Newest first, as the database returns it.
      requestRow('new-pending', {
        createdAt: new Date('2026-10-30T10:00:00.000Z'),
      }),
      requestRow('old-escalated', {
        status: SupportRequestStatus.ESCALATED,
        createdAt: new Date('2026-10-29T10:00:00.000Z'),
      }),
      requestRow('old-pending', {
        timing: SupportTiming.URGENT_UNSAFE,
        createdAt: new Date('2026-10-28T10:00:00.000Z'),
      }),
    ]);

    const result = await service.counsellor('user-1');

    expect(result.supportRequests.map((row) => row.id)).toEqual([
      'old-escalated',
      'old-pending',
      'new-pending',
    ]);
    expect(result.supportRequests[0].urgency).toBe('URGENT');
  });

  it('counts urgent and unread awaiting requests before the preview cap', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([
      // Urgent but already opened by this reviewer — counts toward urgent, not unread.
      requestRow('urgent-read', {
        status: SupportRequestStatus.ESCALATED,
        readAt: new Date('2026-10-30T11:00:00.000Z'),
      }),
      // Urgent and still unread.
      requestRow('urgent-unread', { timing: SupportTiming.URGENT_UNSAFE }),
      // Normal and unread.
      requestRow('normal-unread'),
    ]);

    const result = await service.counsellor('user-1');

    // Two urgent (escalated + unsafe), regardless of read state; two unread.
    expect(result.urgentRequestCount).toBe(2);
    expect(result.unreadRequestCount).toBe(2);
    expect(result.supportRequests.find((row) => row.id === 'urgent-read')?.readAt).not.toBeNull();
  });

  it('caps the preview at 20 rows without capping the fetch that ranks it', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([
      requestRow('escalated-last', {
        status: SupportRequestStatus.ESCALATED,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      }),
      ...Array.from({ length: 25 }, (_, id) =>
        requestRow(`pending-${id}`, {
          createdAt: new Date(`2026-10-2${id % 9}T10:00:00.000Z`),
        }),
      ),
    ]);

    const result = await service.counsellor('user-1');

    expect(result.supportRequests).toHaveLength(20);
    expect(result.supportRequests[0].id).toBe('escalated-last');
    // Sorting a `take: 20` picked by the clock would have dropped the oldest
    // urgent row before it could ever be ordered.
    expect(prisma.supportRequest.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() }),
    );
  });

  it('counts open flags for the school only', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([]);

    await service.counsellor('user-1');

    expect(prisma.supportFlag.count).toHaveBeenCalledWith({
      where: { ...SCHOOL, status: SupportFlagStatus.OPEN },
    });
  });

  it('counts escalated requests separately from the awaiting total', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue([
      requestRow('r1', { status: SupportRequestStatus.ESCALATED }),
      requestRow('r2'),
    ]);
    prisma.supportRequest.count.mockResolvedValue(1);

    const result = await service.counsellor('user-1');

    expect(result.pendingRequestCount).toBe(2);
    expect(result.escalatedRequestCount).toBe(1);
    expect(prisma.supportRequest.count).toHaveBeenCalledWith({
      where: { ...SCHOOL, status: SupportRequestStatus.ESCALATED },
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
      expect.objectContaining({ where: AWAITING_WHERE }),
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
      pendingRequestCount: 0,
      escalatedRequestCount: 0,
      urgentRequestCount: 0,
      unreadRequestCount: 0,
      openFlagCount: 0,
      upcomingDropIn: null,
    });
    expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    expect(prisma.supportFlag.count).not.toHaveBeenCalled();
    expect(prisma.emotionalCheckIn.findMany).not.toHaveBeenCalled();
    expect(prisma.supportRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.supportRequest.count).not.toHaveBeenCalled();
  });

  it('reports every awaiting request even when the preview is capped', async () => {
    prisma.supportFlag.findMany.mockResolvedValue([]);
    prisma.supportFlag.count.mockResolvedValue(0);
    prisma.emotionalCheckIn.findMany.mockResolvedValue([]);
    prisma.supportRequest.findMany.mockResolvedValue(
      Array.from({ length: 47 }, (_, id) => requestRow(`req-${id}`)),
    );

    const result = await service.counsellor('user-1');

    expect(result.supportRequests).toHaveLength(20);
    expect(result.pendingRequestCount).toBe(47);
  });
});
