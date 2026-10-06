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
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: input.meta ?? undefined,
      },
    });
  }

  list(params: { take?: number }) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: params.take ?? 50,
    });
  }
}
