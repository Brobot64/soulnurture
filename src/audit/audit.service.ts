import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { schoolOf } from '../common/tenant/school-scope.js';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
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
    // PE-15: a row is only readable by the school it belongs to, so the school
    // has to be on it at write time. When the caller had no subject-school to
    // hand, the actor's own school is the tenant the event happened in.
    const schoolId =
      input.schoolId ??
      (input.actorId ? await schoolOf(this.prisma, input.actorId) : null);
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: input.meta ?? undefined,
        schoolId,
        priorStatus: input.priorStatus ?? null,
        newStatus: input.newStatus ?? null,
        ruleId: input.ruleId ?? null,
        ruleVersion: input.ruleVersion ?? null,
      },
    });
  }

  /**
   * The school-scoped read (PE-15). Tenancy is the whole point of the audit
   * trail for a staff reviewer: it says who in THIS school touched what. A
   * staff account with no school is entitled to no tenant's rows, so it fails
   * closed rather than falling back to an unscoped list.
   */
  async list(
    actorUserId: string,
    params: { take?: number; actions?: string[] } = {},
  ) {
    const schoolId = await schoolOf(this.prisma, actorUserId);
    if (!schoolId) {
      throw new ForbiddenException(
        'Your account must be linked to a school to read the audit log.',
      );
    }
    return this.prisma.auditLog.findMany({
      where: {
        schoolId,
        ...(params.actions && params.actions.length > 0
          ? { action: { in: params.actions } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 50,
    });
  }
}
