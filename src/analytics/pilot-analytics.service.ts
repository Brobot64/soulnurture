import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PILOT_FEATURES,
  PILOT_SMALL_GROUP_THRESHOLD,
  PILOT_THEME_LABELS,
  PILOT_THEMES,
  resolvePilotWindow,
  topicTheme,
  triggerTheme,
  type PilotTheme,
  type PilotWindow,
  type PilotWindowQuery,
} from './analytics.constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPPORT_REQUEST_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'ESCALATED',
] as const;

const FLAG_STATUSES = [
  'OPEN',
  'IN_REVIEW',
  'ACKNOWLEDGED',
  'RESOLVED',
  'ESCALATED',
] as const;

const FLAG_SEVERITIES = ['TIER_1_MODERATE', 'TIER_2_HIGH', 'TIER_3_ACUTE'] as const;

const OPEN_FLAG_STATUSES = new Set([
  'OPEN',
  'IN_REVIEW',
  'ACKNOWLEDGED',
  'ESCALATED',
]);
export interface PilotQuery extends PilotWindowQuery {
  schoolId?: string;
}

interface TotalsRow {
  check_ins: number;
  ai_interactions: number;
  voice_interactions: number;
  text_interactions: number;
  resources_accessed: number;
  activities_started: number;
  support_requests_total: number;
}

interface FeatureRow {
  feature: string;
  uses: number;
  students: number;
}

interface DailyRow {
  date: string;
  active_users: number;
  check_ins: number;
}

interface EngagementRow {
  active: number;
  dau: number;
  wau: number;
  mau: number;
  new_students: number;
}

interface ReturnRow {
  prior_active: number;
  returned: number;
}

interface DayCountRow {
  date: string;
  count: number;
}

interface SessionsRow {
  sessions: number;
  students: number;
  avg_minutes: number | null;
}

interface ThemeRow {
  source: string;
  key: string;
  uid: string;
}

interface ResourceRow {
  id: string;
  title: string;
  saves: number;
  students: number;
}

interface CategoryRow {
  category: string;
  saves: number;
  students: number;
}

interface ActivityRow {
  started: number;
  completed: number;
}

interface RequestRow {
  status: string;
  count: number;
  urgent: number;
}

interface ThreadRow {
  created: number;
  claimed: number;
  closed: number;
  avg_claim_hours: number | null;
}

interface FollowUpRow {
  completed: number;
  open: number;
}

interface SupportSeriesRow {
  date: string;
  requests: number;
  threads: number;
}

interface FlagRow {
  severity: string;
  status: string;
  count: number;
}

interface FlagResolutionRow {
  resolved: number;
  avg_hours: number | null;
}

interface SchoolInfo {
  id: string;
  name: string;
  shortCode: string | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function toDayMap(rows: DayCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.date, Number(row.count)]));
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type CsvValue = string | number | null;

/// Super-admin pilot analytics: aggregate-only metrics across the pilot —
/// engagement, feature usage, wellbeing themes, resources, human support and
/// safeguarding. Every breakdown cell backed by 1–4 distinct students is
/// suppressed so the dashboard can never be read against an individual.
@Injectable()
export class PilotAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async pilotAnalytics(query: PilotQuery) {
    const window = this.resolveWindow(query);
    const school = await this.requireSchool(query.schoolId);
    return this.buildPilot(window, school?.id ?? null, school);
  }

  async pilotReport(query: PilotQuery) {
    const window = this.resolveWindow(query);
    const school = await this.requireSchool(query.schoolId);
    const payload = await this.buildPilot(window, school?.id ?? null, school);
    const stamp = `${payload.window.from}_${payload.window.to}`;
    const suffix = payload.school ? `-${payload.school.shortCode ?? payload.school.id}` : '';
    return {
      csv: this.buildCsv(payload),
      filename: `soul-nurture-pilot-${stamp}${suffix}.csv`,
    };
  }

  private resolveWindow(query: PilotQuery): PilotWindow {
    try {
      return resolvePilotWindow(query);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private async requireSchool(schoolId?: string): Promise<SchoolInfo | null> {
    if (!schoolId) return null;
    if (!UUID_PATTERN.test(schoolId)) throw new NotFoundException('School not found');
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, shortCode: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  private schoolFilter(schoolId: string | null, column: Prisma.Sql) {
    return schoolId ? Prisma.sql`AND ${column} = ${schoolId}::uuid` : Prisma.empty;
  }

  /// One row per tracked student event across the very different lanes
  /// (check-ins, AI-lane messages, human-lane messages, guided activities,
  /// toolbox saves, support requests). Voice vs text is decided by the
  /// persisted flags — never inferred. Deactivated students are excluded.
  private eventsUnion(
    start: string,
    endExclusive: string,
    schoolId: string | null,
  ): Prisma.Sql {
    return Prisma.sql`
      SELECT 'check_in'::text AS kind, sp."userId" AS uid, ec."createdAt" AS created
      FROM emotional_check_in ec
      JOIN student_profile sp ON sp.id = ec."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE ec."createdAt" >= ${start}::date AND ec."createdAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      UNION ALL
      SELECT CASE WHEN cm."viaVoice" THEN 'ai_voice' ELSE 'ai_text' END, sp."userId", cm."createdAt"
      FROM conversation_message cm
      JOIN conversation c ON c.id = cm."conversationId"
      JOIN student_profile sp ON sp.id = c."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE cm.role = 'USER'
        AND cm."createdAt" >= ${start}::date AND cm."createdAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      UNION ALL
      SELECT CASE WHEN m."viaVoice" THEN 'chat_voice' ELSE 'chat_text' END, sp."userId", m."createdAt"
      FROM chat_message m
      JOIN chat_thread t ON t.id = m."threadId"
      JOIN student_profile sp ON sp.id = t."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE m.role = 'STUDENT'
        AND m."createdAt" >= ${start}::date AND m."createdAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`t."schoolId"`)}
      UNION ALL
      SELECT 'activity'::text, sp."userId", a."startedAt"
      FROM activity_session a
      JOIN student_profile sp ON sp.id = a."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE a."startedAt" >= ${start}::date AND a."startedAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      UNION ALL
      SELECT 'toolbox'::text, sp."userId", ti."createdAt"
      FROM toolbox_item ti
      JOIN student_profile sp ON sp.id = ti."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE ti."createdAt" >= ${start}::date AND ti."createdAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
      UNION ALL
      SELECT 'support'::text, sp."userId", sr."createdAt"
      FROM support_request sr
      JOIN student_profile sp ON sp.id = sr."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      WHERE sr."createdAt" >= ${start}::date AND sr."createdAt" < ${endExclusive}::date
        ${this.schoolFilter(schoolId, Prisma.sql`u."schoolId"`)}
    `;
  }

  private eventsCte(
    name: string,
    start: string,
    endExclusive: string,
    schoolId: string | null,
  ): Prisma.Sql {
    return Prisma.sql`${Prisma.raw(name)} AS (${this.eventsUnion(start, endExclusive, schoolId)})`;
  }

  private async buildPilot(
    window: PilotWindow,
    schoolId: string | null,
    school: SchoolInfo | null,
  ) {
    const { from, to, days } = window;
    const start = isoDay(from);
    const endExclusive = isoDay(addDays(to, 1));
    const dates = Array.from({ length: days }, (_, index) =>
      isoDay(addDays(from, index)),
    );
    const dauStart = isoDay(to);
    const wauStart = isoDay(maxDate(addDays(to, -6), from));
    const mauStart = isoDay(maxDate(addDays(to, -29), from));
    const prevFrom = isoDay(addDays(from, -days));

    const cte = (name: string, s: string, e: string) =>
      this.eventsCte(name, s, e, schoolId);
    const sf = (column: Prisma.Sql) => this.schoolFilter(schoolId, column);

    const [
      totalsRows,
      featureRows,
      dailyRows,
      engagementRows,
      returnRows,
      sessionsRows,
      themeRows,
      resourceRows,
      categoryRows,
      saveSeriesRows,
      activityRows,
      requestRows,
      threadRows,
      followUpRows,
      supportSeriesRows,
      flagRows,
      flagResolutionRows,
      studentsOnboarded,
      newStudents,
    ] = await Promise.all([
      this.prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
        WITH ${cte('events', start, endExclusive)}
        SELECT
          CAST(COUNT(*) FILTER (WHERE kind = 'check_in') AS int) AS check_ins,
          CAST(COUNT(*) FILTER (WHERE kind IN ('ai_text', 'ai_voice')) AS int) AS ai_interactions,
          CAST(COUNT(*) FILTER (WHERE kind IN ('ai_voice', 'chat_voice')) AS int) AS voice_interactions,
          CAST(COUNT(*) FILTER (WHERE kind IN ('ai_text', 'chat_text')) AS int) AS text_interactions,
          CAST(COUNT(*) FILTER (WHERE kind = 'toolbox') AS int) AS resources_accessed,
          CAST(COUNT(*) FILTER (WHERE kind = 'activity') AS int) AS activities_started,
          CAST(COUNT(*) FILTER (WHERE kind = 'support') AS int) AS support_requests_total
        FROM events
      `),
      this.prisma.$queryRaw<FeatureRow[]>(Prisma.sql`
        WITH ${cte('events', start, endExclusive)}
        SELECT mapped.feature AS feature,
               COUNT(*)::int AS uses,
               COUNT(DISTINCT mapped.uid)::int AS students
        FROM (
          SELECT f.feature, e.uid
          FROM events e
          JOIN (VALUES
            ('check_in', 'check_in'),
            ('ai_text', 'ai_chat'),
            ('ai_voice', 'ai_chat'),
            ('ai_voice', 'voice'),
            ('chat_voice', 'voice'),
            ('chat_text', 'human_support'),
            ('activity', 'reflection'),
            ('toolbox', 'resources'),
            ('support', 'human_support')
          ) AS f(kind, feature) ON f.kind = e.kind
        ) AS mapped
        GROUP BY 1
      `),
      this.prisma.$queryRaw<DailyRow[]>(Prisma.sql`
        WITH ${cte('events', start, endExclusive)}
        SELECT to_char(date_trunc('day', created), 'YYYY-MM-DD') AS date,
               COUNT(DISTINCT uid)::int AS active_users,
               CAST(COUNT(*) FILTER (WHERE kind = 'check_in') AS int) AS check_ins
        FROM events
        GROUP BY 1
      `),
      this.prisma.$queryRaw<EngagementRow[]>(Prisma.sql`
        WITH ${cte('events', start, endExclusive)}
        SELECT
          COUNT(DISTINCT e.uid)::int AS active,
          CAST(COUNT(DISTINCT e.uid) FILTER (WHERE e.created >= ${dauStart}::date) AS int) AS dau,
          CAST(COUNT(DISTINCT e.uid) FILTER (WHERE e.created >= ${wauStart}::date) AS int) AS wau,
          CAST(COUNT(DISTINCT e.uid) FILTER (WHERE e.created >= ${mauStart}::date) AS int) AS mau,
          CAST(COUNT(DISTINCT e.uid) FILTER (WHERE u."createdAt" >= ${start}::date) AS int) AS new_students
        FROM events e
        JOIN "user" u ON u.id = e.uid
      `),
      this.prisma.$queryRaw<ReturnRow[]>(Prisma.sql`
        WITH ${cte('prev', prevFrom, start)}, ${cte('cur', start, endExclusive)}
        SELECT COUNT(DISTINCT p.uid)::int AS prior_active,
               COUNT(DISTINCT c.uid)::int AS returned
        FROM prev p
        LEFT JOIN (SELECT DISTINCT uid FROM cur) c ON c.uid = p.uid
      `),
      this.prisma.$queryRaw<SessionsRow[]>(Prisma.sql`
        WITH conv AS (
          SELECT c.id AS cid, sp."userId" AS uid,
                 MIN(cm."createdAt") AS first_at, MAX(cm."createdAt") AS last_at,
                 COUNT(*)::int AS n
          FROM conversation_message cm
          JOIN conversation c ON c.id = cm."conversationId"
          JOIN student_profile sp ON sp.id = c."studentId"
          JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
          WHERE cm.role = 'USER'
            AND cm."createdAt" >= ${start}::date AND cm."createdAt" < ${endExclusive}::date
            ${sf(Prisma.sql`u."schoolId"`)}
          GROUP BY c.id, sp."userId"
        )
        SELECT COUNT(*)::int AS sessions,
               COUNT(DISTINCT uid)::int AS students,
               CAST(AVG(EXTRACT(EPOCH FROM (last_at - first_at)) / 60) FILTER (WHERE n >= 2) AS float8) AS avg_minutes
        FROM conv
      `),
      this.prisma.$queryRaw<ThemeRow[]>(Prisma.sql`
        SELECT 'trigger'::text AS source, trg AS key, sp."userId" AS uid
        FROM emotional_check_in ec
        JOIN student_profile sp ON sp.id = ec."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        CROSS JOIN LATERAL unnest(ec."triggers") AS trg
        WHERE ec."createdAt" >= ${start}::date AND ec."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        UNION ALL
        SELECT 'topic'::text, tp, sp."userId"
        FROM session_summary ss
        JOIN student_profile sp ON sp.id = ss."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        CROSS JOIN LATERAL unnest(ss."topics") AS tp
        WHERE ss."createdAt" >= ${start}::date AND ss."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
      `),
      this.prisma.$queryRaw<ResourceRow[]>(Prisma.sql`
        SELECT wr.id AS id, wr.title AS title,
               COUNT(*)::int AS saves,
               COUNT(DISTINCT sp."userId")::int AS students
        FROM toolbox_item ti
        JOIN wellbeing_resource wr ON wr.id = ti."resourceId"
        JOIN student_profile sp ON sp.id = ti."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE ti."createdAt" >= ${start}::date AND ti."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        GROUP BY wr.id, wr.title
        ORDER BY saves DESC, wr.title ASC
        LIMIT 8
      `),
      this.prisma.$queryRaw<CategoryRow[]>(Prisma.sql`
        SELECT wr.category::text AS category,
               COUNT(*)::int AS saves,
               COUNT(DISTINCT sp."userId")::int AS students
        FROM toolbox_item ti
        JOIN wellbeing_resource wr ON wr.id = ti."resourceId"
        JOIN student_profile sp ON sp.id = ti."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE ti."createdAt" >= ${start}::date AND ti."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        GROUP BY 1
        ORDER BY saves DESC
      `),
      this.prisma.$queryRaw<DayCountRow[]>(Prisma.sql`
        SELECT to_char(date_trunc('day', ti."createdAt"), 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS count
        FROM toolbox_item ti
        JOIN student_profile sp ON sp.id = ti."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE ti."createdAt" >= ${start}::date AND ti."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<ActivityRow[]>(Prisma.sql`
        SELECT COUNT(*)::int AS started,
               CAST(COUNT(*) FILTER (WHERE a."completedAt" IS NOT NULL) AS int) AS completed
        FROM activity_session a
        JOIN student_profile sp ON sp.id = a."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE a."startedAt" >= ${start}::date AND a."startedAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
      `),
      this.prisma.$queryRaw<RequestRow[]>(Prisma.sql`
        SELECT sr.status::text AS status,
               COUNT(*)::int AS count,
               CAST(COUNT(*) FILTER (WHERE sr.timing = 'URGENT_UNSAFE') AS int) AS urgent
        FROM support_request sr
        JOIN student_profile sp ON sp.id = sr."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE sr."createdAt" >= ${start}::date AND sr."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<ThreadRow[]>(Prisma.sql`
        SELECT COUNT(*)::int AS created,
               CAST(COUNT(*) FILTER (WHERE t."claimedAt" IS NOT NULL) AS int) AS claimed,
               CAST(COUNT(*) FILTER (WHERE t."closedAt" IS NOT NULL) AS int) AS closed,
               CAST(AVG(EXTRACT(EPOCH FROM (t."claimedAt" - t."createdAt")) / 3600) AS float8) AS avg_claim_hours
        FROM chat_thread t
        WHERE t."createdAt" >= ${start}::date AND t."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`t."schoolId"`)}
      `),
      this.prisma.$queryRaw<FollowUpRow[]>(Prisma.sql`
        SELECT
          CAST(COUNT(*) FILTER (WHERE f."completedAt" >= ${start}::date AND f."completedAt" < ${endExclusive}::date) AS int) AS completed,
          CAST(COUNT(*) FILTER (WHERE f."createdAt" >= ${start}::date AND f."createdAt" < ${endExclusive}::date AND f."status" IN ('PENDING', 'SCHEDULED')) AS int) AS open
        FROM follow_up f
        JOIN student_profile sp ON sp.id = f."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE (f."completedAt" >= ${start}::date AND f."completedAt" < ${endExclusive}::date)
           OR (f."createdAt" >= ${start}::date AND f."createdAt" < ${endExclusive}::date)
          ${sf(Prisma.sql`u."schoolId"`)}
      `),
      this.prisma.$queryRaw<SupportSeriesRow[]>(Prisma.sql`
        SELECT to_char(date_trunc('day', created), 'YYYY-MM-DD') AS date,
               CAST(COUNT(*) FILTER (WHERE kind = 'requests') AS int) AS requests,
               CAST(COUNT(*) FILTER (WHERE kind = 'threads') AS int) AS threads
        FROM (
          SELECT sr."createdAt" AS created, 'requests'::text AS kind
          FROM support_request sr
          JOIN student_profile sp ON sp.id = sr."studentId"
          JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
          WHERE sr."createdAt" >= ${start}::date AND sr."createdAt" < ${endExclusive}::date
            ${sf(Prisma.sql`u."schoolId"`)}
          UNION ALL
          SELECT t."createdAt", 'threads'
          FROM chat_thread t
          WHERE t."createdAt" >= ${start}::date AND t."createdAt" < ${endExclusive}::date
            ${sf(Prisma.sql`t."schoolId"`)}
        ) AS combined
        GROUP BY 1
      `),
      this.prisma.$queryRaw<FlagRow[]>(Prisma.sql`
        SELECT f.severity::text AS severity, f.status::text AS status,
               COUNT(*)::int AS count
        FROM support_flag f
        JOIN student_profile sp ON sp.id = f."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE f."createdAt" >= ${start}::date AND f."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
        GROUP BY 1, 2
      `),
      this.prisma.$queryRaw<FlagResolutionRow[]>(Prisma.sql`
        SELECT CAST(COUNT(*) FILTER (WHERE f."resolvedAt" IS NOT NULL) AS int) AS resolved,
               CAST(AVG(EXTRACT(EPOCH FROM (f."resolvedAt" - f."createdAt")) / 3600) AS float8) AS avg_hours
        FROM support_flag f
        JOIN student_profile sp ON sp.id = f."studentId"
        JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
        WHERE f."createdAt" >= ${start}::date AND f."createdAt" < ${endExclusive}::date
          ${sf(Prisma.sql`u."schoolId"`)}
      `),
      this.prisma.user.count({
        where: { role: 'STUDENT', ...(schoolId ? { schoolId } : {}) },
      }),
      this.prisma.user.count({
        where: {
          role: 'STUDENT',
          ...(schoolId ? { schoolId } : {}),
          createdAt: { gte: from, lt: addDays(to, 1) },
        },
      }),
    ]);

    const totals: TotalsRow = totalsRows[0] ?? {
      check_ins: 0,
      ai_interactions: 0,
      voice_interactions: 0,
      text_interactions: 0,
      resources_accessed: 0,
      activities_started: 0,
      support_requests_total: 0,
    };
    const engagementRow: EngagementRow = engagementRows[0] ?? {
      active: 0,
      dau: 0,
      wau: 0,
      mau: 0,
      new_students: 0,
    };
    const returnRow: ReturnRow = returnRows[0] ?? { prior_active: 0, returned: 0 };
    const sessionsRow: SessionsRow = sessionsRows[0] ?? {
      sessions: 0,
      students: 0,
      avg_minutes: null,
    };
    const activityRow: ActivityRow = activityRows[0] ?? { started: 0, completed: 0 };
    const threadRow: ThreadRow = threadRows[0] ?? {
      created: 0,
      claimed: 0,
      closed: 0,
      avg_claim_hours: null,
    };
    const followUpRow: FollowUpRow = followUpRows[0] ?? { completed: 0, open: 0 };
    const flagResolutionRow: FlagResolutionRow = flagResolutionRows[0] ?? {
      resolved: 0,
      avg_hours: null,
    };

    const featuresByDay = new Map(dailyRows.map((row) => [row.date, row]));
    const savesByDay = toDayMap(saveSeriesRows);
    const supportByDay = new Map(supportSeriesRows.map((row) => [row.date, row]));

    const requestsByStatus = Object.fromEntries(
      SUPPORT_REQUEST_STATUSES.map((status) => [status, 0]),
    ) as Record<string, number>;
    let urgentRequests = 0;
    let supportRequestsTotal = 0;
    for (const row of requestRows) {
      const count = Number(row.count);
      supportRequestsTotal += count;
      urgentRequests += Number(row.urgent);
      if (row.status in requestsByStatus) requestsByStatus[row.status] = count;
    }

    const flagsBySeverity = Object.fromEntries(
      FLAG_SEVERITIES.map((severity) => [severity, 0]),
    ) as Record<string, number>;
    const flagsByStatus = Object.fromEntries(
      FLAG_STATUSES.map((status) => [status, 0]),
    ) as Record<string, number>;
    let flagsTotal = 0;
    for (const row of flagRows) {
      const count = Number(row.count);
      flagsTotal += count;
      if (row.severity in flagsBySeverity) flagsBySeverity[row.severity] = count;
      if (row.status in flagsByStatus) flagsByStatus[row.status] = count;
    }

    const featureMap = new Map(featureRows.map((row) => [row.feature, row]));
    const featureUsage = PILOT_FEATURES.map(({ id, label }) => {
      if (id === 'profile') {
        return {
          id,
          label,
          uses: null,
          students: null,
          suppressed: false,
          available: false,
          note: 'Profile activity is not tracked server-side yet.',
        };
      }
      const row = featureMap.get(id);
      const uses = row ? Number(row.uses) : 0;
      const mask = this.maskStudents(row ? Number(row.students) : 0);
      return {
        id,
        label,
        uses,
        students: mask.students,
        suppressed: mask.suppressed,
        available: true,
      };
    });

    const themeStats = new Map<PilotTheme, { mentions: number; students: Set<string> }>();
    for (const row of themeRows) {
      const theme = row.source === 'trigger' ? triggerTheme(row.key) : topicTheme(row.key);
      const stats = themeStats.get(theme) ?? { mentions: 0, students: new Set<string>() };
      stats.mentions += 1;
      stats.students.add(row.uid);
      themeStats.set(theme, stats);
    }
    const wellbeingThemes = PILOT_THEMES.map((id) => {
      const stats = themeStats.get(id);
      const students = stats ? stats.students.size : 0;
      const mask = this.maskStudents(students);
      return {
        id,
        label: PILOT_THEME_LABELS[id],
        mentions: stats?.mentions ?? 0,
        students: mask.students,
        suppressed: mask.suppressed,
      };
    });

    const resolvedFlags =
      flagResolutionRow.resolved ?? 0;
    const openFlags = FLAG_STATUSES.reduce(
      (sum, status) => (OPEN_FLAG_STATUSES.has(status) ? sum + flagsByStatus[status] : sum),
      0,
    );
    const unresolvedRequests = SUPPORT_REQUEST_STATUSES.reduce(
      (sum, status) =>
        status === 'COMPLETED' || status === 'CANCELLED'
          ? sum
          : sum + requestsByStatus[status],
      0,
    );
    const completedReferrals = Number(threadRow.closed) + Number(followUpRow.completed);

    return {
      generatedAt: new Date().toISOString(),
      window: { from: start, to: isoDay(to), days },
      school: school
        ? { id: school.id, name: school.name, shortCode: school.shortCode }
        : null,
      suppression: {
        threshold: PILOT_SMALL_GROUP_THRESHOLD,
        note: `Student counts of 1–${PILOT_SMALL_GROUP_THRESHOLD - 1} are withheld so the dashboard cannot be read against an individual.`,
      },
      overview: {
        studentsOnboarded: Number(studentsOnboarded),
        newStudents: Number(newStudents),
        activeStudents: Number(engagementRow.active),
        checkIns: Number(totals.check_ins),
        aiInteractions: Number(totals.ai_interactions),
        voiceInteractions: Number(totals.voice_interactions),
        resourcesAccessed: Number(totals.resources_accessed),
        supportRequests: supportRequestsTotal,
        completedReferrals,
        avgSatisfaction: {
          available: false,
          reason: 'No satisfaction survey responses have been collected in the pilot yet.',
        },
      },
      engagement: {
        active: Number(engagementRow.active),
        dau: Number(engagementRow.dau),
        wau: Number(engagementRow.wau),
        mau: Number(engagementRow.mau),
        new: Number(engagementRow.new_students),
        returning: Number(engagementRow.active) - Number(engagementRow.new_students),
        returnRate:
          Number(returnRow.prior_active) === 0
            ? null
            : round1((Number(returnRow.returned) / Number(returnRow.prior_active)) * 100),
        checkInsPerActiveStudent:
          Number(engagementRow.active) === 0
            ? null
            : round1(Number(totals.check_ins) / Number(engagementRow.active)),
        avgSessionsPerStudent:
          Number(sessionsRow.students) === 0
            ? null
            : round1(Number(sessionsRow.sessions) / Number(sessionsRow.students)),
        avgSessionMinutes:
          sessionsRow.avg_minutes === null ? null : round1(Number(sessionsRow.avg_minutes)),
        textVsVoice: {
          text: Number(totals.text_interactions),
          voice: Number(totals.voice_interactions),
        },
        series: dates.map((date) => ({
          date,
          activeUsers: Number(featuresByDay.get(date)?.active_users ?? 0),
          checkIns: Number(featuresByDay.get(date)?.check_ins ?? 0),
        })),
      },
      featureUsage,
      wellbeingThemes,
      outcomes: {
        available: false,
        reason:
          'Pre/post survey data has not been collected yet — outcome deltas appear once comparable baselines exist.',
      },
      resources: {
        note: 'Resource views are not instrumented yet — these metrics count saves to the student toolbox.',
        mostSaved: resourceRows.map((row) => {
          const mask = this.maskStudents(Number(row.students));
          return {
            id: row.id,
            title: row.title,
            saves: Number(row.saves),
            students: mask.students,
            suppressed: mask.suppressed,
          };
        }),
        byCategory: categoryRows.map((row) => {
          const mask = this.maskStudents(Number(row.students));
          return {
            category: row.category,
            saves: Number(row.saves),
            students: mask.students,
            suppressed: mask.suppressed,
          };
        }),
        savesSeries: dates.map((date) => ({
          date,
          saves: savesByDay.get(date) ?? 0,
        })),
        activities: {
          started: Number(activityRow.started),
          completed: Number(activityRow.completed),
          completionRate:
            Number(activityRow.started) === 0
              ? null
              : round1((Number(activityRow.completed) / Number(activityRow.started)) * 100),
        },
      },
      support: {
        requests: {
          total: supportRequestsTotal,
          urgent: urgentRequests,
          byStatus: requestsByStatus,
        },
        referrals: {
          created: Number(threadRow.created),
          claimed: Number(threadRow.claimed),
          closed: Number(threadRow.closed),
          avgClaimHours:
            threadRow.avg_claim_hours === null
              ? null
              : round1(Number(threadRow.avg_claim_hours)),
        },
        followUps: {
          completed: Number(followUpRow.completed),
          open: Number(followUpRow.open),
        },
        unresolved: unresolvedRequests,
        series: dates.map((date) => ({
          date,
          requests: Number(supportByDay.get(date)?.requests ?? 0),
          threads: Number(supportByDay.get(date)?.threads ?? 0),
        })),
      },
      safeguarding: {
        flags: {
          total: flagsTotal,
          bySeverity: flagsBySeverity,
          byStatus: flagsByStatus,
        },
        escalations: flagsByStatus.ESCALATED ?? 0,
        urgentRequests,
        followUpStatus: {
          open: openFlags,
          resolved: resolvedFlags,
        },
        avgResolutionHours:
          flagResolutionRow.avg_hours === null
            ? null
            : round1(Number(flagResolutionRow.avg_hours)),
      },
    };
  }

  private maskStudents(students: number): { students: number | null; suppressed: boolean } {
    if (students === 0) return { students: 0, suppressed: false };
    if (students < PILOT_SMALL_GROUP_THRESHOLD) return { students: null, suppressed: true };
    return { students, suppressed: false };
  }

  private buildCsv(payload: Awaited<ReturnType<PilotAnalyticsService['buildPilot']>>): string {
    const rows: [string, string, CsvValue][] = [];
    const push = (section: string, metric: string, value: CsvValue) =>
      rows.push([section, metric, value]);
    const suppressedValue = (students: number | null, suppressed: boolean): CsvValue =>
      suppressed ? `suppressed (<${PILOT_SMALL_GROUP_THRESHOLD})` : students;

    push('Window', 'From', payload.window.from);
    push('Window', 'To', payload.window.to);
    push('Window', 'Days', payload.window.days);
    push('Window', 'School', payload.school ? `${payload.school.name} (${payload.school.shortCode ?? payload.school.id})` : 'All schools');
    push('Window', 'Generated at', payload.generatedAt);

    const overview = payload.overview;
    push('Pilot Reach', 'Students onboarded', overview.studentsOnboarded);
    push('Pilot Reach', 'New students', overview.newStudents);
    push('Pilot Reach', 'Active students', overview.activeStudents);
    push('Pilot Reach', 'Check-ins', overview.checkIns);
    push('Pilot Reach', 'AI interactions', overview.aiInteractions);
    push('Pilot Reach', 'Voice interactions', overview.voiceInteractions);
    push('Pilot Reach', 'Resources saved', overview.resourcesAccessed);
    push('Pilot Reach', 'Support requests', overview.supportRequests);
    push('Pilot Reach', 'Completed referrals', overview.completedReferrals);
    push(
      'Pilot Reach',
      'Average satisfaction',
      overview.avgSatisfaction.available ? null : `not available — ${overview.avgSatisfaction.reason}`,
    );

    const engagement = payload.engagement;
    push('Engagement', 'Active students', engagement.active);
    push('Engagement', 'DAU', engagement.dau);
    push('Engagement', 'WAU', engagement.wau);
    push('Engagement', 'MAU', engagement.mau);
    push('Engagement', 'New (accounts created in window)', engagement.new);
    push('Engagement', 'Returning', engagement.returning);
    push('Engagement', 'Return rate (%)', engagement.returnRate);
    push('Engagement', 'Check-ins per active student', engagement.checkInsPerActiveStudent);
    push('Engagement', 'Avg sessions per student', engagement.avgSessionsPerStudent);
    push('Engagement', 'Avg session minutes', engagement.avgSessionMinutes);
    push('Engagement', 'Text interactions', engagement.textVsVoice.text);
    push('Engagement', 'Voice interactions', engagement.textVsVoice.voice);

    for (const feature of payload.featureUsage) {
      push(
        'Feature Usage',
        feature.label,
        feature.available ? feature.uses : `not available — ${feature.note}`,
      );
      if (feature.available) {
        push(
          'Feature Usage',
          `${feature.label} — students`,
          suppressedValue(feature.students, feature.suppressed),
        );
      }
    }

    for (const theme of payload.wellbeingThemes) {
      push('Wellbeing Trends', `${theme.label} — mentions`, theme.mentions);
      push(
        'Wellbeing Trends',
        `${theme.label} — students`,
        suppressedValue(theme.students, theme.suppressed),
      );
    }

    push('Resources', 'Activities started', payload.resources.activities.started);
    push('Resources', 'Activities completed', payload.resources.activities.completed);
    push('Resources', 'Activity completion rate (%)', payload.resources.activities.completionRate);
    for (const resource of payload.resources.mostSaved) {
      push('Resources', `${resource.title} — saves`, resource.saves);
      push(
        'Resources',
        `${resource.title} — students`,
        suppressedValue(resource.students, resource.suppressed),
      );
    }
    for (const category of payload.resources.byCategory) {
      push('Resources', `${category.category} — saves`, category.saves);
      push(
        'Resources',
        `${category.category} — students`,
        suppressedValue(category.students, category.suppressed),
      );
    }

    const support = payload.support;
    push('Support', 'Support requests', support.requests.total);
    push('Support', 'Urgent requests', support.requests.urgent);
    for (const [status, count] of Object.entries(support.requests.byStatus)) {
      push('Support', `Requests — ${status}`, count);
    }
    push('Support', 'Unresolved requests', support.unresolved);
    push('Support', 'Referral threads created', support.referrals.created);
    push('Support', 'Referral threads claimed', support.referrals.claimed);
    push('Support', 'Referral threads closed', support.referrals.closed);
    push('Support', 'Avg claim time (hours)', support.referrals.avgClaimHours);
    push('Support', 'Follow-ups completed', support.followUps.completed);
    push('Support', 'Follow-ups open', support.followUps.open);

    const safeguarding = payload.safeguarding;
    push('Safeguarding', 'Flags total', safeguarding.flags.total);
    for (const [severity, count] of Object.entries(safeguarding.flags.bySeverity)) {
      push('Safeguarding', `Flags — ${severity}`, count);
    }
    for (const [status, count] of Object.entries(safeguarding.flags.byStatus)) {
      push('Safeguarding', `Flags — ${status}`, count);
    }
    push('Safeguarding', 'Escalations', safeguarding.escalations);
    push('Safeguarding', 'Urgent requests', safeguarding.urgentRequests);
    push('Safeguarding', 'Follow-ups open', safeguarding.followUpStatus.open);
    push('Safeguarding', 'Follow-ups resolved', safeguarding.followUpStatus.resolved);
    push('Safeguarding', 'Avg resolution time (hours)', safeguarding.avgResolutionHours);

    push(
      'Outcomes',
      'Pre/post deltas',
      payload.outcomes.available ? null : `not available — ${payload.outcomes.reason}`,
    );

    const lines = [
      'Section,Metric,Value',
      ...rows.map((row) => row.map(csvCell).join(',')),
    ];
    return `${lines.join('\n')}\n`;
  }
}
