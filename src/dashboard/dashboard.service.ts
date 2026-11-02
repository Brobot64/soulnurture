import { Injectable } from '@nestjs/common';
import {
  SupportFlagStatus,
  SupportRequestStatus,
  type FeelingLabel,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { inSchool, schoolOf } from '../common/tenant/school-scope.js';
import { deriveUrgency } from '../support-requests/queue-status.js';

const OPEN_FLAG_STATUSES = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
  SupportFlagStatus.ACKNOWLEDGED,
];

/** Awaiting a professional's first action: nobody has accepted these yet. */
const AWAITING_REQUEST_STATUSES = [
  SupportRequestStatus.PENDING,
  SupportRequestStatus.ESCALATED,
];

/** Identifiers a staff row may be labelled with, most specific first. */
const REQUEST_STUDENT_SELECT = {
  firstName: true,
  lastName: true,
  displayName: true,
  classLabel: true,
  studentCode: true,
  studentRef: true,
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async counsellor(userId: string) {
    const schoolId = await schoolOf(this.prisma, userId);
    // Staff with no school get an empty portal rather than the platform's data.
    if (!schoolId) {
      return {
        flags: [],
        barometer: this.buildBarometer([]),
        supportRequests: [],
        pendingRequestCount: 0,
        escalatedRequestCount: 0,
        urgentRequestCount: 0,
        unreadRequestCount: 0,
        openFlagCount: 0,
        upcomingDropIn: null,
      };
    }
    const scope = inSchool(schoolId);

    const flags = await this.prisma.supportFlag.findMany({
      where: { ...scope, status: { in: OPEN_FLAG_STATUSES } },
      // Acute FIRST. Postgres orders an enum by its declaration order, so
      // 'asc' reads TIER_1_MODERATE → TIER_3_ACUTE and buried the urgent rows
      // under the preview cap — the overview was showing a counsellor the
      // mildest signals in the school.
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });

    const openFlagCount = await this.prisma.supportFlag.count({
      where: { ...scope, status: SupportFlagStatus.OPEN },
    });

    const recentCheckIns = await this.prisma.emotionalCheckIn.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { feeling: true },
    });
    const barometer = this.buildBarometer(recentCheckIns.map((c) => c.feeling));

    const requestScope = { ...scope, status: { in: AWAITING_REQUEST_STATUSES } };
    // No `take` here: an escalated request from yesterday must outrank a
    // pending one from a minute ago, and sorting 20 rows picked by the clock
    // would have thrown the older urgent one away before it ever got ordered.
    const awaiting = await this.prisma.supportRequest.findMany({
      where: requestScope,
      include: {
        reads: { where: { userId }, select: { readAt: true } },
        supportPerson: {
          select: { id: true, name: true, type: true, title: true },
        },
        student: { select: REQUEST_STUDENT_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    });

    const derived = awaiting.map((request) => ({
      request,
      readAt: request.reads[0]?.readAt ?? null,
      urgency: deriveUrgency({
        status: request.status,
        timing: request.timing,
        followUps: [],
      }),
    }));
    const urgentRequestCount = derived.filter((row) => row.urgency === 'URGENT').length;
    const unreadRequestCount = derived.filter((row) => row.readAt === null).length;

    const supportRequests = derived
      .sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency === 'URGENT' ? -1 : 1;
        return b.request.createdAt.getTime() - a.request.createdAt.getTime();
      })
      .slice(0, 20)
      .map(({ request, urgency, readAt }) => ({
        id: request.id,
        status: request.status,
        timing: request.timing,
        urgency,
        readAt,
        note: request.note,
        initialMessage: request.initialMessage,
        initialMessageAt: request.initialMessageAt,
        createdAt: request.createdAt,
        conversationId: request.conversationId,
        supportPerson: request.supportPerson,
        student: request.student,
      }));

    const pendingRequestCount = awaiting.length;
    const escalatedRequestCount = await this.prisma.supportRequest.count({
      where: { ...scope, status: SupportRequestStatus.ESCALATED },
    });

    return {
      flags,
      barometer,
      supportRequests,
      pendingRequestCount,
      escalatedRequestCount,
      urgentRequestCount,
      unreadRequestCount,
      openFlagCount,
      upcomingDropIn: null,
    };
  }

  private buildBarometer(feelings: FeelingLabel[]) {
    const total = feelings.length;
    const distribution = feelings.reduce<Record<string, number>>((acc, f) => {
      acc[f] = (acc[f] ?? 0) + 1;
      return acc;
    }, {});

    const dominant =
      total === 0
        ? null
        : Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0];

    return {
      total,
      dominant,
      distribution,
      notes:
        total === 0
          ? 'No check-ins in the recent window yet.'
          : 'Based on the most recent 100 check-ins from your school.',
    };
  }
}
