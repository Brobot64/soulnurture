import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FeelingIntensity,
  FeelingLabel,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import {
  resolvePilotWindow,
  type PilotWindowQuery,
} from '../analytics/analytics.constants.js';
import type { CreateCheckInFeedbackDto } from './dto/create-check-in-feedback.dto.js';

/// Post-check-in feelings ranked on the same signed scale so before/after
/// pairs are comparable: positive labels score +intensity, negative labels
/// -intensity (A_LITTLE=1 … A_LOT=3). The delta maps onto IMPROVED / SAME /
/// WORSENED for the platform-admin mood-effect report.
const POSITIVE_FEELINGS = new Set<FeelingLabel>([
  'CALM',
  'HOPEFUL',
  'GREAT',
  'HAPPY',
  'PEACEFUL',
]);

const INTENSITY_RANK: Record<FeelingIntensity, number> = {
  A_LITTLE: 1,
  SOMEWHAT: 2,
  A_LOT: 3,
};

export type MoodEffect = 'IMPROVED' | 'SAME' | 'WORSENED';

function moodScore(
  feeling: FeelingLabel,
  intensity: FeelingIntensity,
): number {
  const sign = POSITIVE_FEELINGS.has(feeling) ? 1 : -1;
  return sign * INTENSITY_RANK[intensity];
}

export function moodEffect(
  before: { feeling: FeelingLabel; intensity: FeelingIntensity },
  after: { feeling: FeelingLabel; intensity: FeelingIntensity },
): MoodEffect {
  const delta = moodScore(after.feeling, after.intensity) - moodScore(before.feeling, before.intensity);
  return delta > 0 ? 'IMPROVED' : delta < 0 ? 'WORSENED' : 'SAME';
}

interface FeedbackReportRow {
  feedback_id: string;
  submitted_at: Date;
  school_name: string | null;
  student_name: string | null;
  student_email: string | null;
  check_in_id: string;
  check_in_at: Date;
  feeling_before: FeelingLabel;
  intensity_before: FeelingIntensity;
  feeling_after: FeelingLabel;
  intensity_after: FeelingIntensity;
}

interface ReportQuery extends PilotWindowQuery {
  schoolId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/// Post-check-in mood feedback: one "how do you feel now?" answer per
/// check-in, stored apart from the check-in so the platform admin can export
/// the effect a check-in had on each student's mood.
@Injectable()
export class CheckInFeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async submit(userId: string, checkInId: string, dto: CreateCheckInFeedbackDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const checkIn = await this.prisma.emotionalCheckIn.findUnique({
      where: { id: checkInId },
    });
    if (!checkIn) throw new NotFoundException('Check-in not found');
    if (checkIn.studentId !== student.id) throw new ForbiddenException();
    try {
      return await this.prisma.checkInFeedback.create({
        data: {
          checkInId,
          studentId: student.id,
          feeling: dto.feeling,
          intensity: dto.intensity,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Feedback already submitted for this check-in',
        );
      }
      throw error;
    }
  }

  async getForCheckIn(userId: string, checkInId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const checkIn = await this.prisma.emotionalCheckIn.findUnique({
      where: { id: checkInId },
    });
    if (!checkIn) throw new NotFoundException('Check-in not found');
    if (checkIn.studentId !== student.id) throw new ForbiddenException();
    const feedback = await this.prisma.checkInFeedback.findUnique({
      where: { checkInId },
    });
    return { feedback };
  }

  async moodEffectReport(query: ReportQuery) {
    let window;
    try {
      window = resolvePilotWindow(query);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const school = await this.requireSchool(query.schoolId);

    const start = isoDay(window.from);
    const endExclusive = isoDay(addDays(window.to, 1));
    const rows = await this.prisma.$queryRaw<FeedbackReportRow[]>(Prisma.sql`
      SELECT
        f.id AS feedback_id,
        f."createdAt" AS submitted_at,
        s.name AS school_name,
        COALESCE(
          NULLIF(sp."displayName", ''),
          sp."firstName" || ' ' || COALESCE(sp."lastName", '')
        ) AS student_name,
        u.email AS student_email,
        f."checkInId" AS check_in_id,
        ec."createdAt" AS check_in_at,
        ec.feeling AS feeling_before,
        ec.intensity AS intensity_before,
        f.feeling AS feeling_after,
        f.intensity AS intensity_after
      FROM check_in_feedback f
      JOIN emotional_check_in ec ON ec.id = f."checkInId"
      JOIN student_profile sp ON sp.id = f."studentId"
      JOIN "user" u ON u.id = sp."userId" AND u."deactivatedAt" IS NULL
      LEFT JOIN school s ON s.id = u."schoolId"
      WHERE f."createdAt" >= ${start}::date AND f."createdAt" < ${endExclusive}::date
        ${school ? Prisma.sql`AND u."schoolId" = ${school.id}::uuid` : Prisma.empty}
      ORDER BY f."createdAt" ASC
    `);

    return {
      csv: this.buildCsv(rows),
      filename: `soul-nurture-check-in-mood-${start}_${isoDay(window.to)}${
        school ? `-${school.shortCode ?? school.id}` : ''
      }.csv`,
    };
  }

  private async requireSchool(schoolId?: string) {
    if (!schoolId) return null;
    if (!UUID_PATTERN.test(schoolId)) {
      throw new NotFoundException('School not found');
    }
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, shortCode: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  private buildCsv(rows: FeedbackReportRow[]): string {
    const header =
      'feedbackId,submittedAt,school,studentName,studentEmail,checkInId,checkInAt,feelingBefore,intensityBefore,feelingAfter,intensityAfter,moodEffect';
    const lines = rows.map((row) =>
      [
        row.feedback_id,
        row.submitted_at.toISOString(),
        row.school_name,
        row.student_name,
        row.student_email,
        row.check_in_id,
        row.check_in_at.toISOString(),
        row.feeling_before,
        row.intensity_before,
        row.feeling_after,
        row.intensity_after,
        moodEffect(
          { feeling: row.feeling_before, intensity: row.intensity_before },
          { feeling: row.feeling_after, intensity: row.intensity_after },
        ),
      ]
        .map(csvCell)
        .join(','),
    );
    return `${[header, ...lines].join('\n')}\n`;
  }
}
