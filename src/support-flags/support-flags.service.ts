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
import {
  INTENT_LEVEL_MAPPING_VERSION,
  levelOriginForFlag,
} from '../ai/intents/indicator-levels.js';

const LEVELS: string[] = Object.values(IndicatorLevel);

/** The chip set is fixed: four levels plus the unclassified bucket. */
function emptyLevelCounts(): Record<IndicatorLevel | 'UNCLASSIFIED', number> {
  return { A: 0, B: 0, C: 0, U: 0, UNCLASSIFIED: 0 };
}

/**
 * What graded this flag. `INDICATOR_RULE` is unreachable today because every rule
 * in `indicators.config.ts` is `configured: false` and so leaves `ruleId` null;
 * the other two are the automatic writers, and telling them apart is the whole
 * point — a level that came from the AI's own alert tier is not a §3 condition
 * grade, and a reviewer has to be able to see which one they are looking at.
 */
function levelSourceOf(flag: {
  level: IndicatorLevel | null;
  ruleId: string | null;
  intentId: string | null;
}): 'INDICATOR_RULE' | 'INTENT_MAPPING' | 'AI_TIER' | null {
  if (flag.level === null) return null;
  if (flag.ruleId) return 'INDICATOR_RULE';
  return levelOriginForFlag(flag);
}

function levelSourceVersionOf(flag: {
  level: IndicatorLevel | null;
  ruleId: string | null;
  ruleVersion: string | null;
}): string | null {
  if (flag.level === null) return null;
  return flag.ruleId ? flag.ruleVersion : INTENT_LEVEL_MAPPING_VERSION;
}

/**
 * ab01's "Search by Student ID/email". It matches the identifiers a reviewer
 * actually has in front of them: the code printed under a student's name, and
 * the address their account was made with. An empty term adds no predicate, so
 * an unfiltered list reads exactly as it did before.
 */
function studentSearch(q?: string): Prisma.SupportFlagWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { studentRef: { contains: term, mode: 'insensitive' } },
      { student: { studentCode: { contains: term, mode: 'insensitive' } } },
      { student: { studentRef: { contains: term, mode: 'insensitive' } } },
      { student: { user: { email: { contains: term, mode: 'insensitive' } } } },
    ],
  };
}

@Injectable()
export class SupportFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    userId: string,
    filters: { severity?: string; status?: string; level?: string; q?: string },
  ) {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) {
      return { items: [], openCount: 0, levelCounts: emptyLevelCounts() };
    }

    // Everything except `level` is part of the set a level chip counts, so the
    // number on a chip is the rows that chip then returns (the queue rule).
    // A search term joins that scope for the same reason: a Level B chip saying
    // 3 has to return those 3 rows for the student being searched for.
    const scope: Prisma.SupportFlagWhereInput = {
      ...inSchool(schoolId),
      ...(filters.severity ? { severity: filters.severity as never } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
      ...studentSearch(filters.q),
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

    // A linked request is a fact about a *different* record, so it is read from
    // that table rather than inferred from the flag's own status. Only the newest
    // request on the same conversation is named, because a student can ask twice.
    const conversationIds = items
      .map((item) => item.conversationId)
      .filter((id): id is string => Boolean(id));
    const linkedRequests =
      conversationIds.length > 0
        ? await this.prisma.supportRequest.findMany({
            where: {
              conversationId: { in: conversationIds },
              ...inSchool(schoolId),
            },
            select: { id: true, conversationId: true, status: true },
            orderBy: { createdAt: 'desc' },
          })
        : [];
    const byConversation = new Map<string, { id: string; status: string }>();
    for (const request of linkedRequests) {
      if (request.conversationId && !byConversation.has(request.conversationId)) {
        byConversation.set(request.conversationId, {
          id: request.id,
          status: request.status,
        });
      }
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
    return {
      items: items.map((item) => ({
        ...item,
        linkedRequest: item.conversationId
          ? (byConversation.get(item.conversationId) ?? null)
          : null,
      })),
      openCount,
      levelCounts,
    };
  }

  /** US-D02: the four kinds of content on a flag are labelled, not merged. */
  async detail(userId: string, id: string) {
    const flag = await this.scopedFlag(userId, id);
    const rule = flag.ruleId ? indicatorRuleById(flag.ruleId) : undefined;
    // Whether a student-initiated request shares this conversation is a fact
    // about that record, read from its own table and never inferred from the
    // flag. Same student, newest request, because a student can ask twice.
    const linkedRequest = flag.conversationId
      ? await this.prisma.supportRequest.findFirst({
          where: { conversationId: flag.conversationId, studentId: flag.studentId },
          select: { id: true, status: true },
          orderBy: { createdAt: 'desc' },
        })
      : null;
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
        linkedRequest,
        ruleId: flag.ruleId,
        ruleVersion: flag.ruleVersion,
        ruleLabel: rule?.label ?? null,
        ruleConfigured: rule ? rule.configured : null,
        ruleBlockedOn: rule?.blockedOn ?? null,
        // §7.5 and §10: a level on a reviewer's screen has to say what produced
        // it. No IND-* rule is switched on, so an automatic level came either from
        // the §3 condition table or from the AI's own alert tier, and this reports
        // which — so a provisional grade cannot read as a clinical one.
        levelSource: levelSourceOf(flag),
        levelSourceVersion: levelSourceVersionOf(flag),
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
    const recordedAt = new Date();
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
    // ab06's confirmation needs two facts the reviewer cannot invent locally:
    // when the server wrote this, and which status it is still sitting on.
    return { message: 'Review decision recorded', decision, recordedAt, status: flag.status };
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
            studentId: true,
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
