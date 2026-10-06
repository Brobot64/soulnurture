import { Injectable, NotFoundException } from '@nestjs/common';
import { SupportFlagStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SupportFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    _userId: string,
    filters: { severity?: string; status?: string },
  ) {
    const items = await this.prisma.supportFlag.findMany({
      where: {
        ...(filters.severity ? { severity: filters.severity as never } : {}),
        ...(filters.status ? { status: filters.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const openCount = await this.prisma.supportFlag.count({
      where: {
        status: {
          in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW],
        },
      },
    });
    return { items, openCount };
  }

  async acknowledge(userId: string, id: string) {
    const flag = await this.prisma.supportFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundException('Flag not found');
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
    const flag = await this.prisma.supportFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundException('Flag not found');
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
}
