import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { PilotAnalyticsService } from './pilot-analytics.service.js';

const SCHOOL_ID = '11111111-2222-3333-4444-555555555555';

function textOf(sql: unknown): string {
  return (sql as { strings: string[] }).strings.join('?');
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('PilotAnalyticsService', () => {
  let service: PilotAnalyticsService;
  const prisma = {
    $queryRaw: vi.fn(),
    user: { count: vi.fn() },
    school: { findUnique: vi.fn() },
  };

  /// Each raw query is dispatched on a unique marker in its SQL text so
  /// tests can feed rows without depending on the call order of ~19
  /// parallel queries.
  function dispatch(overrides: Record<string, unknown> = {}) {
    const entries = Object.entries(overrides);
    prisma.$queryRaw.mockImplementation(async (sql: unknown) => {
      const text = textOf(sql);
      for (const [marker, value] of entries) {
        if (text.includes(marker)) return value;
      }
      return [];
    });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    dispatch();
    prisma.user.count.mockResolvedValue(0);
    prisma.school.findUnique.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PilotAnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PilotAnalyticsService);
  });

  it('zero-fills the default 30-day payload and marks unavailable metrics', async () => {
    const result = await service.pilotAnalytics({});

    expect(result.window.days).toBe(30);
    expect(result.window.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.window.to).toBe(isoDay(new Date()));
    expect(result.school).toBeNull();
    expect(result.suppression.threshold).toBe(5);
    expect(result.overview).toEqual({
      studentsOnboarded: 0,
      newStudents: 0,
      activeStudents: 0,
      checkIns: 0,
      aiInteractions: 0,
      voiceInteractions: 0,
      resourcesAccessed: 0,
      supportRequests: 0,
      completedReferrals: 0,
      avgSatisfaction: { available: false, reason: expect.any(String) },
    });
    expect(result.engagement.series).toHaveLength(30);
    expect(result.engagement.series[29].date).toBe(isoDay(new Date()));
    expect(result.engagement.returnRate).toBeNull();
    expect(result.engagement.avgSessionMinutes).toBeNull();
    expect(result.featureUsage).toHaveLength(7);
    const profile = result.featureUsage.find((row) => row.id === 'profile');
    expect(profile).toMatchObject({ available: false, uses: null, students: null });
    expect(result.wellbeingThemes).toHaveLength(8);
    expect(result.wellbeingThemes[0]).toEqual({
      id: 'academic_pressure',
      label: 'Academic pressure',
      mentions: 0,
      students: 0,
      suppressed: false,
    });
    expect(Object.keys(result.support.requests.byStatus)).toEqual([
      'PENDING',
      'ACCEPTED',
      'SCHEDULED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'ESCALATED',
    ]);
    expect(Object.keys(result.safeguarding.flags.byStatus)).toEqual([
      'OPEN',
      'IN_REVIEW',
      'ACKNOWLEDGED',
      'RESOLVED',
      'ESCALATED',
    ]);
    expect(Object.keys(result.safeguarding.flags.bySeverity)).toEqual([
      'TIER_1_MODERATE',
      'TIER_2_HIGH',
      'TIER_3_ACUTE',
    ]);
    expect(result.outcomes.available).toBe(false);
    expect(result.resources.savesSeries).toHaveLength(30);
    expect(result.support.series).toHaveLength(30);
    expect(prisma.user.count).toHaveBeenCalledTimes(2);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'STUDENT' },
    });
  });

  it('honours a custom from/to window inclusively', async () => {
    const result = await service.pilotAnalytics({
      from: '2026-01-01',
      to: '2026-01-10',
    });

    expect(result.window).toEqual({ from: '2026-01-01', to: '2026-01-10', days: 10 });
    expect(result.engagement.series).toHaveLength(10);
    expect(result.engagement.series[0].date).toBe('2026-01-01');
    expect(result.engagement.series[9].date).toBe('2026-01-10');
  });

  it('clamps a preset days request into 1..366', async () => {
    expect((await service.pilotAnalytics({ days: '3650' })).window.days).toBe(366);
    expect((await service.pilotAnalytics({ days: 'junk' })).window.days).toBe(30);
  });

  it('rejects malformed windows with 400s before querying', async () => {
    await expect(service.pilotAnalytics({ from: '2026-01-01' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.pilotAnalytics({ to: '2026-01-01' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.pilotAnalytics({ from: '2026-01-31', to: '2026-01-01' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.pilotAnalytics({ from: '2026-02-31', to: '2026-03-01' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.pilotAnalytics({ from: '2025-01-01', to: '2026-06-01' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('404s an unknown school and rejects non-uuid ids without a lookup', async () => {
    await expect(service.pilotAnalytics({ schoolId: SCHOOL_ID })).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.pilotAnalytics({ schoolId: 'not-a-uuid' })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.school.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('scopes to the selected school and echoes it in the payload', async () => {
    prisma.school.findUnique.mockResolvedValue({
      id: SCHOOL_ID,
      name: 'Greenfield Secondary',
      shortCode: 'GRN',
    });

    const result = await service.pilotAnalytics({ schoolId: SCHOOL_ID });

    expect(result.school).toEqual({
      id: SCHOOL_ID,
      name: 'Greenfield Secondary',
      shortCode: 'GRN',
    });
    expect(prisma.school.findUnique).toHaveBeenCalledWith({
      where: { id: SCHOOL_ID },
      select: { id: true, name: true, shortCode: true },
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'STUDENT', schoolId: SCHOOL_ID },
    });
  });

  it('suppresses breakdown cells backed by 1-4 students only', async () => {
    dispatch({
      'AS trg': [
        // academic_pressure: 4 distinct students -> suppressed.
        ...['u1', 'u2', 'u3', 'u4'].map((uid) => ({
          source: 'trigger',
          key: 'School',
          uid,
        })),
        // family: 5 distinct students -> reported.
        ...['u1', 'u2', 'u3', 'u4', 'u5'].map((uid) => ({
          source: 'trigger',
          key: 'family',
          uid,
        })),
      ],
      'f(kind, feature)': [{ feature: 'check_in', uses: 10, students: 3 }],
      'LIMIT 8': [{ id: 'r1', title: 'Exam anxiety guide', saves: 9, students: 2 }],
    });

    const result = await service.pilotAnalytics({});

    const academic = result.wellbeingThemes.find((t) => t.id === 'academic_pressure');
    expect(academic).toEqual({
      id: 'academic_pressure',
      label: 'Academic pressure',
      mentions: 4,
      students: null,
      suppressed: true,
    });
    const family = result.wellbeingThemes.find((t) => t.id === 'family');
    expect(family).toMatchObject({ mentions: 5, students: 5, suppressed: false });

    const checkIn = result.featureUsage.find((row) => row.id === 'check_in');
    expect(checkIn).toMatchObject({ uses: 10, students: null, suppressed: true });
    const others = result.featureUsage.find((row) => row.id === 'voice');
    expect(others).toMatchObject({ uses: 0, students: 0, suppressed: false });

    expect(result.resources.mostSaved[0]).toMatchObject({
      title: 'Exam anxiety guide',
      saves: 9,
      students: null,
      suppressed: true,
    });
  });

  it('derives engagement math from the raw rows', async () => {
    dispatch({
      support_requests_total: [
        {
          check_ins: 12,
          ai_interactions: 20,
          voice_interactions: 4,
          text_interactions: 28,
          resources_accessed: 6,
          activities_started: 3,
          support_requests_total: 2,
        },
      ],
      'AS dau': [
        { active: 20, dau: 7, wau: 15, mau: 18, new_students: 5 },
      ],
      prior_active: [{ prior_active: 10, returned: 4 }],
      active_users: [
        { date: isoDay(new Date()), active_users: 7, check_ins: 2 },
      ],
      avg_minutes: [{ sessions: 10, students: 4, avg_minutes: 12.34 }],
      'AS urgent': [
        { status: 'PENDING', count: 1, urgent: 1 },
        { status: 'COMPLETED', count: 1, urgent: 0 },
      ],
      avg_claim_hours: [
        { created: 3, claimed: 2, closed: 1, avg_claim_hours: 1.55 },
      ],
      'AS open': [{ completed: 2, open: 1 }],
      'AS started': [{ started: 6, completed: 3 }],
      'AS severity': [
        { severity: 'TIER_2_HIGH', status: 'OPEN', count: 2 },
        { severity: 'TIER_1_MODERATE', status: 'RESOLVED', count: 1 },
      ],
      avg_hours: [{ resolved: 1, avg_hours: 30.25 }],
    });

    const result = await service.pilotAnalytics({});

    expect(result.overview).toMatchObject({
      activeStudents: 20,
      checkIns: 12,
      aiInteractions: 20,
      voiceInteractions: 4,
      resourcesAccessed: 6,
      supportRequests: 2,
      completedReferrals: 3,
    });
    expect(result.engagement).toMatchObject({
      active: 20,
      dau: 7,
      wau: 15,
      mau: 18,
      new: 5,
      returning: 15,
      returnRate: 40,
      checkInsPerActiveStudent: 0.6,
      avgSessionsPerStudent: 2.5,
      avgSessionMinutes: 12.3,
      textVsVoice: { text: 28, voice: 4 },
    });
    expect(result.engagement.series[29]).toEqual({
      date: isoDay(new Date()),
      activeUsers: 7,
      checkIns: 2,
    });
    expect(result.support.requests).toMatchObject({ total: 2, urgent: 1 });
    expect(result.support.requests.byStatus.PENDING).toBe(1);
    expect(result.support.requests.byStatus.COMPLETED).toBe(1);
    expect(result.support.referrals).toEqual({
      created: 3,
      claimed: 2,
      closed: 1,
      avgClaimHours: 1.6,
    });
    expect(result.support.followUps).toEqual({ completed: 2, open: 1 });
    expect(result.support.unresolved).toBe(1);
    expect(result.resources.activities).toEqual({
      started: 6,
      completed: 3,
      completionRate: 50,
    });
    expect(result.safeguarding.flags.total).toBe(3);
    expect(result.safeguarding.flags.byStatus.OPEN).toBe(2);
    expect(result.safeguarding.flags.byStatus.RESOLVED).toBe(1);
    expect(result.safeguarding.escalations).toBe(0);
    expect(result.safeguarding.urgentRequests).toBe(1);
    expect(result.safeguarding.followUpStatus).toEqual({ open: 2, resolved: 1 });
    expect(result.safeguarding.avgResolutionHours).toBe(30.3);
  });

  it('exports the same window as a CSV attachment payload', async () => {
    dispatch({
      'AS trg': ['u1', 'u2', 'u3', 'u4'].map((uid) => ({
        source: 'trigger',
        key: 'school',
        uid,
      })),
    });
    prisma.school.findUnique.mockResolvedValue({
      id: SCHOOL_ID,
      name: 'Greenfield Secondary',
      shortCode: 'GRN',
    });

    const { csv, filename } = await service.pilotReport({
      from: '2026-01-01',
      to: '2026-01-10',
      schoolId: SCHOOL_ID,
    });

    expect(filename).toBe('soul-nurture-pilot-2026-01-01_2026-01-10-GRN.csv');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Section,Metric,Value');
    expect(lines[1]).toBe('Window,From,2026-01-01');
    expect(lines[2]).toBe('Window,To,2026-01-10');
    expect(csv).toContain('Window,School,Greenfield Secondary (GRN)');
    expect(csv).toContain('Pilot Reach,Students onboarded,0');
    expect(csv).toContain('Wellbeing Trends,Academic pressure — students,suppressed (<5)');
    expect(csv).toContain('Feature Usage,Profile,not available');
    expect(csv).toContain('Outcomes,Pre/post deltas,not available');
    expect(csv).toContain('Safeguarding,Flags total,0');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('rejects malformed windows for the CSV report too', async () => {
    await expect(service.pilotReport({ from: '01-01-2026' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
