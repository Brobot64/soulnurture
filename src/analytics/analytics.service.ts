import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SchoolUsersService } from '../schools/school-users.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_KINDS,
  activityKindOf,
  FEELING_TO_MOOD,
  MOOD_IDS,
  type ActivityKind,
  type AnalyticsWindowDays,
  type MoodId,
  WEEKDAY_LABELS,
} from './analytics.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DayCountRow {
  date: string;
  count: number;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function toDayMap(rows: DayCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.date, Number(row.count)]));
}

/// Fixed 7d vs previous 7d, derived from the windowed series (every window
/// is ≥ 14 days, so both segments are always complete). `pct` is null when
/// there is no previous baseline.
function windowDelta(values: number[]) {
  const current = values.slice(-7).reduce((sum, value) => sum + value, 0);
  const previous = values.slice(-14, -7).reduce((sum, value) => sum + value, 0);
  const pct =
    previous === 0
      ? null
      : Math.round(((current - previous) / previous) * 1000) / 10;
  return { current, previous, pct };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schoolUsers: SchoolUsersService,
  ) {}

  platformAnalytics(days: AnalyticsWindowDays) {
    return this.buildAnalytics(null, days);
  }

  async schoolAnalytics(
    actorId: string,
    schoolId: string,
    days: AnalyticsWindowDays,
  ) {
    await this.schoolUsers.requireSchoolAccess(actorId, schoolId);
    await this.requireSchool(schoolId);
    return this.buildAnalytics(schoolId, days);
  }

  async platformActivity(limit?: string, kind?: string) {
    return this.activity(null, limit, kind);
  }

  async schoolActivity(
    actorId: string,
    schoolId: string,
    limit?: string,
    kind?: string,
  ) {
    await this.schoolUsers.requireSchoolAccess(actorId, schoolId);
    await this.requireSchool(schoolId);
    return this.activity(schoolId, limit, kind);
  }

  private async buildAnalytics(
    schoolId: string | null,
    days: AnalyticsWindowDays,
  ) {
    const now = new Date();
    // Day buckets follow the DB clock (timestamps are stored without zone);
    // UTC dates keep JS and Postgres aligned.
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const start = isoDay(addDays(today, -(days - 1)));
    const endExclusive = isoDay(addDays(today, 1));
    const dates = Array.from({ length: days }, (_, index) =>
      isoDay(addDays(today, -(days - 1) + index)),
    );

    const [userRows, checkInRows, threadRows, messageRows, moodRows, weekdayRows] =
      await Promise.all([
        this.userSeries(start, endExclusive, schoolId),
        this.checkInSeries(start, endExclusive, schoolId),
        this.threadSeries(start, endExclusive, schoolId),
        this.messageSeries(start, endExclusive, schoolId),
        this.moodRows(start, endExclusive, schoolId),
        this.weekdayRows(start, endExclusive, schoolId),
      ]);

    const usersByDay = toDayMap(userRows);
    const checkInsByDay = toDayMap(checkInRows);
    const threadsByDay = toDayMap(threadRows);
    const messagesByDay = toDayMap(messageRows);

    const series = dates.map((date) => ({
      date,
      newUsers: usersByDay.get(date) ?? 0,
      checkIns: checkInsByDay.get(date) ?? 0,
      chatThreads: threadsByDay.get(date) ?? 0,
      chatMessages: messagesByDay.get(date) ?? 0,
    }));

    const distribution = Object.fromEntries(
      MOOD_IDS.map((mood) => [mood, 0]),
    ) as Record<MoodId, number>;
    let moodTotal = 0;
    for (const row of moodRows) {
      const mood = FEELING_TO_MOOD[row.feeling];
      if (!mood) continue;
      distribution[mood] += Number(row.count);
      moodTotal += Number(row.count);
    }

    const weekdayCounts = new Map(
      weekdayRows.map((row) => [Number(row.weekday), Number(row.count)]),
    );
    const weekday = WEEKDAY_LABELS.map((label, index) => ({
      weekday: label,
      count: weekdayCounts.get(index + 1) ?? 0,
    }));

    const base = {
      windowDays: days,
      series,
      deltas: {
        newUsers: windowDelta(series.map((day) => day.newUsers)),
        checkIns: windowDelta(series.map((day) => day.checkIns)),
        chatThreads: windowDelta(series.map((day) => day.chatThreads)),
        chatMessages: windowDelta(series.map((day) => day.chatMessages)),
      },
      mood: { total: moodTotal, distribution },
      weekday,
    };
    if (!schoolId) return base;

    const [students, professionals, admins, deactivated, rosterTotal, incomplete] =
      await Promise.all([
        this.prisma.user.count({ where: { schoolId, role: 'STUDENT' } }),
        this.prisma.user.count({
          where: { schoolId, role: { in: [...STAFF_ROLES] } },
        }),
        this.prisma.user.count({
          where: { schoolId, role: { in: ['SCHOOL_ADMIN', 'PLATFORM_ADMIN'] } },
        }),
        this.prisma.user.count({
          where: { schoolId, deactivatedAt: { not: null } },
        }),
        this.prisma.user.count({ where: { schoolId } }),
        this.prisma.user.count({
          where: {
            schoolId,
            OR: [{ mustChangePassword: true }, { emailVerified: false }],
          },
        }),
      ]);
    return {
      ...base,
      roster: { students, professionals, admins, deactivated },
      onboarding: {
        incomplete,
        percentComplete:
          rosterTotal === 0
            ? 100
            : Math.round(((rosterTotal - incomplete) / rosterTotal) * 1000) / 10,
      },
    };
  }

  private schoolFilter(schoolId: string | null, column: Prisma.Sql) {
    return schoolId
      ? Prisma.sql`AND ${column} = ${schoolId}::uuid`
      : Prisma.empty;
  }

  private userSeries(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', u."createdAt"), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM "user" u
      WHERE u."createdAt" >= ${start}::date
        AND u."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      GROUP BY 1
    `);
  }

  private checkInSeries(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', ec."createdAt"), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM emotional_check_in ec
      JOIN student_profile sp ON sp.id = ec."studentId"
      JOIN "user" u ON u.id = sp."userId"
      WHERE ec."createdAt" >= ${start}::date
        AND ec."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      GROUP BY 1
    `);
  }

  private threadSeries(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', t."createdAt"), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM chat_thread t
      WHERE t."createdAt" >= ${start}::date
        AND t."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`t."schoolId"`)}
      GROUP BY 1
    `);
  }

  private messageSeries(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', m."createdAt"), 'YYYY-MM-DD') AS date,
             COUNT(*)::int AS count
      FROM chat_message m
      JOIN chat_thread t ON t.id = m."threadId"
      WHERE m."createdAt" >= ${start}::date
        AND m."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`t."schoolId"`)}
      GROUP BY 1
    `);
  }

  private moodRows(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<{ feeling: string; count: number }[]>(Prisma.sql`
      SELECT ec."feeling"::text AS feeling, COUNT(*)::int AS count
      FROM emotional_check_in ec
      JOIN student_profile sp ON sp.id = ec."studentId"
      JOIN "user" u ON u.id = sp."userId"
      WHERE ec."createdAt" >= ${start}::date
        AND ec."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      GROUP BY 1
    `);
  }

  private weekdayRows(start: string, end: string, schoolId: string | null) {
    return this.prisma.$queryRaw<{ weekday: number; count: number }[]>(Prisma.sql`
      SELECT extract(isodow FROM ec."createdAt")::int AS weekday,
             COUNT(*)::int AS count
      FROM emotional_check_in ec
      JOIN student_profile sp ON sp.id = ec."studentId"
      JOIN "user" u ON u.id = sp."userId"
      WHERE ec."createdAt" >= ${start}::date
        AND ec."createdAt" < ${end}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      GROUP BY 1
    `);
  }

  private async activity(
    schoolId: string | null,
    limit?: string,
    kind?: string,
  ) {
    let actions: readonly string[] = ACTIVITY_ACTIONS;
    if (kind && kind !== 'all') {
      if (!(kind in ACTIVITY_KINDS)) {
        throw new UnprocessableEntityException('Unknown activity kind filter');
      }
      actions = ACTIVITY_KINDS[kind as ActivityKind];
    }
    const take = Math.min(Number(limit ?? 50) || 50, 100);

    const rows = await this.prisma.auditLog.findMany({
      where: {
        action: { in: [...actions] },
        ...(schoolId ? { schoolId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { id: true, name: true } },
        school: { select: { id: true, name: true, shortCode: true } },
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        kind: activityKindOf(row.action),
        entity: row.entity,
        entityId: row.entityId,
        meta: row.meta,
        createdAt: row.createdAt,
        actor: row.actor ? { id: row.actor.id, name: row.actor.name } : null,
        school: row.school
          ? {
              id: row.school.id,
              name: row.school.name,
              shortCode: row.school.shortCode,
            }
          : null,
      })),
    };
  }

  private async requireSchool(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }
}
