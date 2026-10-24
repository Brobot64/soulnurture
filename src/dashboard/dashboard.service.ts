import { Injectable } from '@nestjs/common';
import {
  SupportFlagStatus,
  SupportRequestStatus,
  type FeelingLabel,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { inSchool, schoolOf } from '../common/tenant/school-scope.js';

const OPEN_FLAG_STATUSES = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
  SupportFlagStatus.ACKNOWLEDGED,
];

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
        escalatedFlagCount: 0,
        upcomingDropIn: null,
      };
    }
    const scope = inSchool(schoolId);

    const flags = await this.prisma.supportFlag.findMany({
      where: { ...scope, status: { in: OPEN_FLAG_STATUSES } },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    });

    const escalatedFlagCount = await this.prisma.supportFlag.count({
      where: { ...scope, status: SupportFlagStatus.OPEN },
    });

    const recentCheckIns = await this.prisma.emotionalCheckIn.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { feeling: true },
    });
    const barometer = this.buildBarometer(recentCheckIns.map((c) => c.feeling));

    const requestScope = {
      ...scope,
      status: {
        in: [SupportRequestStatus.PENDING, SupportRequestStatus.ESCALATED],
      },
    };
    const requests = await this.prisma.supportRequest.findMany({
      where: requestScope,
      include: { supportPerson: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const pendingRequestCount = await this.prisma.supportRequest.count({
      where: requestScope,
    });

    return {
      flags,
      barometer,
      supportRequests: requests,
      pendingRequestCount,
      escalatedFlagCount,
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
