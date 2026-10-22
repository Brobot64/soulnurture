import { Injectable, NotFoundException } from '@nestjs/common';
import { SupportFlagStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { inSchool, schoolOf } from '../common/tenant/school-scope.js';

@Injectable()
export class SupportFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    userId: string,
    filters: { severity?: string; status?: string },
  ) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) return { items: [], openCount: 0 };

    const items = await this.prisma.supportFlag.findMany({
      where: {
        ...inSchool(schoolId),
        ...(filters.severity ? { severity: filters.severity as never } : {}),
        ...(filters.status ? { status: filters.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const openCount = await this.prisma.supportFlag.count({
      where: {
        ...inSchool(schoolId),
        status: {
          in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW],
        },
      },
    });
    return { items, openCount };
  }

  async acknowledge(userId: string, id: string) {
    await this.scopedFlag(userId, id);
    await this.prisma.supportFlag.update({
      where: { id },
      data: { status: SupportFlagStatus.ACKNOWLEDGED },
    });
    await this.auditService.log({
      actorId: userId,
      action: 'support_flag.acknowledged',
      entity: 'SupportFlag',
      entityId: id,
    });
    return { message: 'Flag acknowledged' };
  }

  async markInReview(userId: string, id: string) {
    await this.scopedFlag(userId, id);
    await this.prisma.supportFlag.update({
      where: { id },
      data: { status: SupportFlagStatus.IN_REVIEW },
    });
    await this.auditService.log({
      actorId: userId,
      action: 'support_flag.in_review',
      entity: 'SupportFlag',
      entityId: id,
    });
    return { message: 'Flag marked in-review' };
  }

  /**
   * A flag the actor's school is not entitled to — because it never existed or
   * because it belongs to another school — reads as 404 either way, so the
   * endpoint never confirms that some other tenant's flag id is real.
   */
  private async scopedFlag(userId: string, id: string) {
    const schoolId = await schoolOf(this.prisma, userId);
    const flag = schoolId
      ? await this.prisma.supportFlag.findFirst({
          where: { id, ...inSchool(schoolId) },
          select: { id: true },
        })
      : null;
    if (!flag) throw new NotFoundException('Flag not found');
    return flag;
  }
}
