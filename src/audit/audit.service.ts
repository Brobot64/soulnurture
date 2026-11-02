import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(input: {
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    meta?: Prisma.InputJsonValue;
    schoolId?: string | null;
    /** US-D03: the transition is recorded as two named states, not implied. */
    priorStatus?: string | null;
    newStatus?: string | null;
    ruleId?: string | null;
    ruleVersion?: string | null;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: input.meta ?? undefined,
        schoolId: input.schoolId ?? null,
        priorStatus: input.priorStatus ?? null,
        newStatus: input.newStatus ?? null,
        ruleId: input.ruleId ?? null,
        ruleVersion: input.ruleVersion ?? null,
      },
    });
  }

  list(params: { take?: number; actions?: string[]; schoolId?: string }) {
    return this.prisma.auditLog.findMany({
      where: {
        ...(params.actions && params.actions.length > 0
          ? { action: { in: params.actions } }
          : {}),
        ...(params.schoolId ? { schoolId: params.schoolId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 50,
    });
  }
}
