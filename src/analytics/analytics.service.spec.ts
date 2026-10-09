import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { SchoolUsersService } from '../schools/school-users.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_KINDS,
  MOOD_IDS,
  WEEKDAY_LABELS,
} from './analytics.constants.js';
import { AnalyticsService } from './analytics.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function expectedDates(days: number): string[] {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Array.from({ length: days }, (_, index) =>
    isoDay(new Date(today.getTime() + (-(days - 1) + index) * DAY_MS)),
  );
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  const prisma = {
    $queryRaw: vi.fn(),
    user: { count: vi.fn() },
    school: { findUnique: vi.fn() },
    auditLog: { findMany: vi.fn() },
  };
  const schoolUsers = { requireSchoolAccess: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.auditLog.findMany.mockResolvedValue([]);
    prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
    schoolUsers.requireSchoolAccess.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SchoolUsersService, useValue: schoolUsers },
      ],
    }).compile();
    service = module.get(AnalyticsService);
  });

  it('zero-fills the platform series and omits school-only sections', async () => {
    const result = await service.platformAnalytics(14);

    expect(result.windowDays).toBe(14);
    expect(result.series).toHaveLength(14);
    const dates = expectedDates(14);
    expect(result.series[0]).toEqual({
      date: dates[0],
      newUsers: 0,
      checkIns: 0,
      chatThreads: 0,
      chatMessages: 0,
    });
    expect(result.series[13].date).toBe(dates[13]);
    expect(result.deltas).toEqual({
      newUsers: { current: 0, previous: 0, pct: null },
      checkIns: { current: 0, previous: 0, pct: null },
      chatThreads: { current: 0, previous: 0, pct: null },
      chatMessages: { current: 0, previous: 0, pct: null },
    });
    expect(result.mood.total).toBe(0);
    expect(Object.keys(result.mood.distribution)).toEqual([...MOOD_IDS]);
    expect(result.weekday).toEqual(
      WEEKDAY_LABELS.map((weekday) => ({ weekday, count: 0 })),
    );
    expect('roster' in result).toBe(false);
    expect('onboarding' in result).toBe(false);
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
  });

  it('derives fixed 7d-vs-previous-7d deltas from the series', async () => {
    const dates = expectedDates(14);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { date: dates[13], count: 15 },
        { date: dates[0], count: 10 },
      ])
      .mockResolvedValueOnce([
        { date: dates[13], count: 13 },
        { date: dates[6], count: 12 },
      ]);

    const result = await service.platformAnalytics(14);

    expect(result.series[13].newUsers).toBe(15);
    expect(result.series[0].newUsers).toBe(10);
    expect(result.deltas.newUsers).toEqual({ current: 15, previous: 10, pct: 50 });
    expect(result.deltas.checkIns).toEqual({ current: 13, previous: 12, pct: 8.3 });
    expect(result.deltas.chatThreads).toEqual({ current: 0, previous: 0, pct: null });
  });

  it('folds raw feelings onto the eight mood faces', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { feeling: 'HAPPY', count: 2 },
        { feeling: 'CALM', count: 3 },
        { feeling: 'SAD_LOW', count: 1 },
        { feeling: 'STRESSED', count: 4 },
        { feeling: 'NOT_A_FEELING', count: 9 },
      ]);

    const result = await service.platformAnalytics(14);

    expect(result.mood.total).toBe(10);
    expect(result.mood.distribution.GREAT).toBe(2);
    expect(result.mood.distribution.NORMAL).toBe(3);
    expect(result.mood.distribution.SAD).toBe(1);
    expect(result.mood.distribution.DISTRAUGHT).toBe(4);
    expect(result.mood.distribution.ANGRY).toBe(0);
  });

  it('zero-fills the weekday histogram in MON..SUN order', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { weekday: 1, count: 5 },
        { weekday: 7, count: 2 },
      ]);

    const result = await service.platformAnalytics(14);

    expect(result.weekday).toEqual([
      { weekday: 'MON', count: 5 },
      { weekday: 'TUE', count: 0 },
      { weekday: 'WED', count: 0 },
      { weekday: 'THU', count: 0 },
      { weekday: 'FRI', count: 0 },
      { weekday: 'SAT', count: 0 },
      { weekday: 'SUN', count: 2 },
    ]);
  });

  it('adds roster and onboarding counts for a school scope', async () => {
    prisma.user.count
      .mockResolvedValueOnce(120)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(130)
      .mockResolvedValueOnce(10);

    const result = await service.schoolAnalytics('actor-1', 'school-1', 30);

    expect(schoolUsers.requireSchoolAccess).toHaveBeenCalledWith(
      'actor-1',
      'school-1',
    );
    expect(result.windowDays).toBe(30);
    if (!('roster' in result)) throw new Error('expected roster section');
    expect(result.roster).toEqual({
      students: 120,
      professionals: 8,
      admins: 2,
      deactivated: 3,
    });
    expect(result.onboarding).toEqual({ incomplete: 10, percentComplete: 92.3 });
    expect(prisma.user.count).toHaveBeenCalledTimes(6);
    expect(prisma.user.count).toHaveBeenNthCalledWith(1, {
      where: { schoolId: 'school-1', role: 'STUDENT' },
    });
    expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
      where: { schoolId: 'school-1', role: { in: [...STAFF_ROLES] } },
    });
    expect(prisma.user.count).toHaveBeenNthCalledWith(6, {
      where: {
        schoolId: 'school-1',
        OR: [{ mustChangePassword: true }, { emailVerified: false }],
      },
    });
  });

  it('reports a fully-onboarded school on an empty roster', async () => {
    prisma.user.count.mockResolvedValue(0);

    const result = await service.schoolAnalytics('actor-1', 'school-1', 14);

    if (!('roster' in result)) throw new Error('expected roster section');
    expect(result.roster).toEqual({
      students: 0,
      professionals: 0,
      admins: 0,
      deactivated: 0,
    });
    expect(result.onboarding).toEqual({ incomplete: 0, percentComplete: 100 });
  });

  it('404s school analytics for a missing school', async () => {
    prisma.school.findUnique.mockResolvedValue(null);

    await expect(
      service.schoolAnalytics('actor-1', 'school-1', 14),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('filters and maps the platform activity feed by kind', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: 'log-1',
        action: 'school.student_enrolled',
        entity: 'User',
        entityId: 'user-9',
        meta: { role: 'STUDENT' },
        createdAt: new Date('2026-10-09T09:00:00.000Z'),
        actor: { id: 'admin-1', name: 'Ada' },
        school: { id: 'school-1', name: 'Springfield', shortCode: 'SPRING' },
      },
    ]);

    const result = await service.platformActivity(undefined, 'people');

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { action: { in: [...ACTIVITY_KINDS.people] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        actor: { select: { id: true, name: true } },
        school: { select: { id: true, name: true, shortCode: true } },
      },
    });
    expect(result.items[0]).toMatchObject({
      id: 'log-1',
      action: 'school.student_enrolled',
      kind: 'people',
      entity: 'User',
      entityId: 'user-9',
      meta: { role: 'STUDENT' },
      actor: { id: 'admin-1', name: 'Ada' },
      school: { id: 'school-1', name: 'Springfield', shortCode: 'SPRING' },
    });
  });

  it('treats kind=all as the union of every feed group', async () => {
    await service.platformActivity('10', 'all');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: { in: [...ACTIVITY_ACTIONS] } },
        take: 10,
      }),
    );
  });

  it('rejects an unknown activity kind without querying', async () => {
    await expect(service.platformActivity('10', 'bogus')).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('caps the activity limit at 100 and falls back to 50', async () => {
    await service.platformActivity('500');
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );

    await service.platformActivity('abc');
    expect(prisma.auditLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('scopes the school activity feed to the school', async () => {
    await service.schoolActivity('actor-1', 'school-1', '20', 'chat');

    expect(schoolUsers.requireSchoolAccess).toHaveBeenCalledWith(
      'actor-1',
      'school-1',
    );
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: { in: [...ACTIVITY_KINDS.chat] },
          schoolId: 'school-1',
        },
        take: 20,
      }),
    );
  });
});
