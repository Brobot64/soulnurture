import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IndicatorLevel,
  Prisma,
  SupportFlagReviewDecision,
  SupportFlagStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { inSchool, schoolOf } from '../common/tenant/school-scope.js';
import { indicatorRuleById } from '../ai/intents/indicators.config.js';

const LEVELS: string[] = Object.values(IndicatorLevel);

/** The chip set is fixed: four levels plus the unclassified bucket. */
function emptyLevelCounts(): Record<IndicatorLevel | 'UNCLASSIFIED', number> {
  return { A: 0, B: 0, C: 0, U: 0, UNCLASSIFIED: 0 };
}

@Injectable()
export class SupportFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    userId: string,
    filters: { severity?: string; status?: string; level?: string },
  ) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) {
      return { items: [], openCount: 0, levelCounts: emptyLevelCounts() };
    }

    // Everything except `level` is part of the set a level chip counts, so the
    // number on a chip is the rows that chip then returns (the queue rule).
    const scope: Prisma.SupportFlagWhereInput = {
      ...inSchool(schoolId),
      ...(filters.severity ? { severity: filters.severity as never } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
    };
    const where: Prisma.SupportFlagWhereInput = filters.level
      ? filters.level === 'UNCLASSIFIED'
        ? { ...scope, level: null }
        : { ...scope, level: this.levelOrThrow(filters.level) }
      : scope;

    const [items, grouped] = await Promise.all([
      this.prisma.supportFlag.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.supportFlag.groupBy({
        by: ['level'],
        where: scope,
        _count: { _all: true },
      }),
    ]);

    const levelCounts = emptyLevelCounts();
    for (const row of grouped) {
      const key = row.level ?? 'UNCLASSIFIED';
      levelCounts[key] = row._count._all;
    }

    // A separate fact from the chip counts: open work in the whole school,
    // whichever filters are currently applied to the list.
    const openCount = await this.prisma.supportFlag.count({
      where: {
        ...inSchool(schoolId),
        status: {
          in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW],
        },
      },
    });
    return { items, openCount, levelCounts };
  }

  /** US-D02: the four kinds of content on a flag are labelled, not merged. */
  async detail(userId: string, id: string) {
    const flag = await this.scopedFlag(userId, id);
    const rule = flag.ruleId ? indicatorRuleById(flag.ruleId) : undefined;
    return {
      studentReported: {
        statement: flag.studentStatementSnapshot,
        triggerLabel: flag.triggerLabel,
      },
      systemMetadata: {
        id: flag.id,
        level: flag.level,
        severity: flag.severity,
        status: flag.status,
        source: flag.source,
        category: flag.category,
        intentId: flag.intentId,
        autoActions: flag.autoActions,
        createdAt: flag.createdAt,
        updatedAt: flag.updatedAt,
        resolvedAt: flag.resolvedAt,
        // Referenced, never inlined: a request, an indicator and a case stay
        // three records with three histories (US-D05).
        conversationId: flag.conversationId,
        ruleId: flag.ruleId,
        ruleVersion: flag.ruleVersion,
        ruleLabel: rule?.label ?? null,
        ruleConfigured: rule ? rule.configured : null,
        ruleBlockedOn: rule?.blockedOn ?? null,
      },
      aiSummary: flag.aiContextSummary,
      humanDecision: {
        reviewDecision: flag.reviewDecision,
        decisions: Object.values(SupportFlagReviewDecision),
      },
      student: { ref: flag.studentRef, classLabel: flag.classLabel },
    };
  }

  async acknowledge(userId: string, id: string) {
    return this.advance(userId, id, SupportFlagStatus.ACKNOWLEDGED, {
      action: 'support_flag.acknowledged',
      message: 'Flag acknowledged',
    });
  }

  async markInReview(userId: string, id: string) {
    return this.advance(userId, id, SupportFlagStatus.IN_REVIEW, {
      action: 'support_flag.in_review',
      message: 'Flag marked in-review',
    });
  }

  /**
   * The workflow status has exactly these two writers. `RESOLVED` is not one of
   * them: nothing here may close a flag, because a level C or a safeguarding
   * report is not cleared by clicking through the queue (US-D10).
   */
  private async advance(
    userId: string,
    id: string,
    status: SupportFlagStatus,
    audit: { action: string; message: string },
  ) {
    const flag = await this.scopedFlag(userId, id);
    await this.prisma.supportFlag.update({ where: { id }, data: { status } });
    await this.auditService.log({
      actorId: userId,
      action: audit.action,
      entity: 'SupportFlag',
      entityId: id,
      priorStatus: flag.status,
      newStatus: status,
      ruleId: flag.ruleId,
      ruleVersion: flag.ruleVersion,
    });
    return { message: audit.message };
  }

  /**
   * G4: the decision is its own field and moves no status, because "we recorded
   * a decision" and "the workflow advanced" are different claims. Status changes
   * stay on their own two endpoints, each audited with prior and new state.
   */
  async recordReviewDecision(
    userId: string,
    id: string,
    decision: SupportFlagReviewDecision,
  ) {
    const flag = await this.scopedFlag(userId, id);
    await this.prisma.supportFlag.update({
      where: { id },
      data: { reviewDecision: decision },
    });
    await this.auditService.log({
      actorId: userId,
      action: 'support_flag.review_decision',
      entity: 'SupportFlag',
      entityId: id,
      priorStatus: flag.status,
      newStatus: flag.status,
      ruleId: flag.ruleId,
      ruleVersion: flag.ruleVersion,
      meta: { decision },
    });
    return { message: 'Review decision recorded', decision };
  }

  private levelOrThrow(level: string): IndicatorLevel {
    if (!LEVELS.includes(level)) {
      throw new BadRequestException(
        `Unknown indicator level ${level}; expected ${LEVELS.join(', ')} or UNCLASSIFIED`,
      );
    }
    return level as IndicatorLevel;
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
          select: {
            id: true,
            status: true,
            ruleId: true,
            ruleVersion: true,
            studentStatementSnapshot: true,
            triggerLabel: true,
            severity: true,
            level: true,
            source: true,
            category: true,
            intentId: true,
            autoActions: true,
            createdAt: true,
            updatedAt: true,
            resolvedAt: true,
            conversationId: true,
            aiContextSummary: true,
            reviewDecision: true,
            studentRef: true,
            classLabel: true,
          },
        })
      : null;
    if (!flag) throw new NotFoundException('Flag not found');
    return flag;
  }
}
