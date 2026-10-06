import { Injectable } from '@nestjs/common';
import {
  SupportFlagStatus,
  SupportRequestStatus,
  type FeelingLabel,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async counsellor(_userId: string) {
    const flags = await this.prisma.supportFlag.findMany({
      where: {
        status: {
          in: [
            SupportFlagStatus.OPEN,
            SupportFlagStatus.IN_REVIEW,
            SupportFlagStatus.ACKNOWLEDGED,
          ],
        },
      },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    });

    const escalatedFlagCount = await this.prisma.supportFlag.count({
      where: { status: SupportFlagStatus.OPEN },
    });

    const recentCheckIns = await this.prisma.emotionalCheckIn.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { feeling: true },
    });
    const barometer = this.buildBarometer(recentCheckIns.map((c) => c.feeling));

    const requests = await this.prisma.supportRequest.findMany({
      where: {
        status: { in: [SupportRequestStatus.PENDING, SupportRequestStatus.ESCALATED] },
      },
      include: { supportPerson: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      flags,
      barometer,
      supportRequests: requests,
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
          : 'Based on the most recent 100 student check-ins.',
    };
  }
}