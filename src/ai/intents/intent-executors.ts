import { Logger } from '@nestjs/common';
import { SupportFlagSeverity, SupportFlagStatus } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import type { AiContext } from '../context/ai-context.service.js';
import type { SupportedLanguage } from '../language/language.config.js';
import type { SupportFlagAlertsService } from '../../support-flags/support-flag-alerts.service.js';
import type { IntentAction } from './intents.config.js';
import type { IntentVerdict } from './intent-engine.service.js';

/**
 * The registered intent actions. Each executor is a small, named function —
 * this registry is the whole "what can an intent DO" surface. Add a new
 * executor here and it instantly becomes available to every intent.
 */
export interface IntentExecutor {
  type: IntentAction['type'];
  execute(
    action: IntentAction,
    verdict: IntentVerdict,
    ctx: IntentApplyContext,
    notes: string[],
  ): Promise<void>;
}

export interface IntentApplyContext {
  prisma: PrismaService;
  auditService: AuditService;
  result: AiGenerationResult;
  studentId: string;
  studentRef: string;
  classLabel: string | null;
  conversationId: string;
  userContent: string;
  relevantResources: AiContext['relevantResources'];
  /** Overrides the derived flag source — the vernacular second pass flags on
   * translated text (SERVER_KEYWORDS match) but must stay AI_CANDIDATE. */
  flagSourceOverride?: 'SERVER_POLICY' | 'AI_CANDIDATE';
  /** Present at every production call site: delivers an acute (TIER_3) flag
   * to the school's professionals as an immediate-follow-up recommendation. */
  flagAlerts?: SupportFlagAlertsService;
  /** Language the caller already resolved per the dominant chain
   * [messageLanguage, preferredLanguage] → 'en'; the alert falls back to the
   * standing preference, then English, when absent. */
  alertLanguage?: SupportedLanguage;
}

const logger = new Logger('IntentExecutors');

/** Active statuses the dedupe check considers "a live flag already exists". */
const ACTIVE_FLAG_STATUSES: SupportFlagStatus[] = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
  SupportFlagStatus.ACKNOWLEDGED,
  SupportFlagStatus.ESCALATED,
];

const SUPPORT_FLAG_EXECUTOR: IntentExecutor = {
  type: 'SUPPORT_FLAG',
  async execute(action, verdict, ctx, notes) {
    if (action.type !== 'SUPPORT_FLAG') return;
    const existing = await ctx.prisma.supportFlag.findFirst({
      where: {
        conversationId: ctx.conversationId,
        category: verdict.category,
        ...(verdict.intentId ? { intentId: verdict.intentId } : {}),
        status: { in: ACTIVE_FLAG_STATUSES },
      },
      select: { id: true },
    });
    if (existing) {
      notes.push(
        `Flag already active for ${verdict.intentId ?? verdict.category} in this conversation; not duplicated.`,
      );
      return;
    }

    const summary = flagSummary(verdict, ctx);
    const created = await ctx.prisma.supportFlag.create({
      data: {
        studentId: ctx.studentId,
        conversationId: ctx.conversationId,
        studentRef: ctx.studentRef,
        classLabel: ctx.classLabel,
        triggerLabel: verdict.intentLabel,
        category: verdict.category,
        severity: verdict.severity,
        status: SupportFlagStatus.OPEN,
        source:
          ctx.flagSourceOverride ??
          (verdict.matchedBy === 'SERVER_KEYWORDS'
            ? 'SERVER_POLICY'
            : 'AI_CANDIDATE'),
        aiContextSummary: summary,
        autoActions: verdict.actions.map((a) => a.type),
        intentId: verdict.intentId,
      },
    });
    await ctx.auditService.log({
      action: 'support_flag.auto_created',
      entity: 'SupportFlag',
      entityId: created.id,
      meta: {
        intentId: verdict.intentId,
        category: verdict.category,
        matchedBy: verdict.matchedBy,
        severity: verdict.severity,
      },
    });
    notes.push(`Safeguarding flag persisted (${verdict.severity}, ${verdict.matchedBy}).`);

    // Over the line: an acute flag must reach the school's professionals even
    // when nothing else does. Alert failure never fails the flag.
    if (verdict.severity === SupportFlagSeverity.TIER_3_ACUTE && ctx.flagAlerts) {
      try {
        const note = await ctx.flagAlerts.recommendImmediateFollowUp({
          flag: created,
          studentMessage: ctx.userContent,
          language: ctx.alertLanguage,
        });
        notes.push(note);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `Acute-flag school alert failed for flag ${created.id}: ${message}`,
        );
        notes.push(`School alert failed: ${message}`);
      }
    }
  },
};

const HUMAN_SUPPORT_PROMPT_EXECUTOR: IntentExecutor = {
  type: 'HUMAN_SUPPORT_PROMPT',
  async execute(action, _verdict, ctx, notes) {
    if (action.type !== 'HUMAN_SUPPORT_PROMPT') return;
    ctx.result.humanSupport = {
      recommended: true,
      type: 'PROFESSIONAL',
      reason: action.reason,
    };
    ctx.result.action = 'HUMAN_SUPPORT';
    notes.push(`Human support pathway surfaced: ${action.reason}`);
  },
};

const SAFETY_MESSAGE_EXECUTOR: IntentExecutor = {
  type: 'SAFETY_MESSAGE',
  async execute(action, _verdict, ctx, notes) {
    if (action.type !== 'SAFETY_MESSAGE') return;
    ctx.result.message = action.message;
    notes.push('Scripted safety message applied (server-side, model wording not trusted for acute risk).');
  },
};

const GROUNDING_EXECUTOR: IntentExecutor = {
  type: 'GROUNDING',
  async execute(action, _verdict, ctx, notes) {
    if (action.type !== 'GROUNDING') return;
    ctx.result.action = 'GROUNDING';
    ctx.result.exerciseLabel = action.exerciseLabel;
    notes.push(`Grounding exercise attached: ${action.exerciseLabel}`);
  },
};

const RECOMMEND_RESOURCE_EXECUTOR: IntentExecutor = {
  type: 'RECOMMEND_RESOURCE',
  async execute(action, _verdict, ctx, notes) {
    if (action.type !== 'RECOMMEND_RESOURCE') return;
    const candidates = action.category
      ? ctx.relevantResources.filter((r) => r.category === action.category)
      : ctx.relevantResources;
    if (candidates.length === 0) {
      notes.push(
        `${action.category ? `No approved resource in category ${action.category}` : 'No approved resources available'}; recommendation left untouched.`,
      );
      return;
    }
    const modelId = ctx.result.resource.resourceId;
    const matchingModel = modelId
      ? candidates.find((r) => r.id === modelId)
      : undefined;
    const pick = matchingModel ?? candidates[0];
    ctx.result.resource = { recommended: true, resourceId: pick.id };
    if (ctx.result.action !== 'HUMAN_SUPPORT') {
      ctx.result.action = 'RESOURCE';
    }
    notes.push(
      `Resource recommendation constrained to approved ${action.category ?? 'catalogue'} picks (${pick.id}).`,
    );
  },
};

const RECOMMEND_ACTIVITY_EXECUTOR: IntentExecutor = {
  type: 'RECOMMEND_ACTIVITY',
  async execute(action, _verdict, ctx, notes) {
    if (action.type !== 'RECOMMEND_ACTIVITY') return;
    // Validate against the live catalogue rather than the bundled config:
    // a reviewer un-approving an activity takes effect without a deploy,
    // and we never point a student at a non-startable row.
    const approved = await ctx.prisma.wellbeingActivity.findMany({
      where: {
        slug: { in: action.activitySlugs },
        active: true,
        approved: true,
      },
      select: { slug: true, title: true },
    });
    const pick = action.activitySlugs
      .map((slug) => approved.find((a) => a.slug === slug))
      .find((a) => a !== undefined);
    if (!pick) {
      notes.push(
        `No approved activity among [${action.activitySlugs.join(', ')}]; recommendation left untouched.`,
      );
      return;
    }
    ctx.result.activity = {
      recommended: true,
      slug: pick.slug,
      title: pick.title,
    };
    notes.push(`Activity recommended from approved catalogue (${pick.slug}).`);
  },
};

/** Execution order follows each intent's own action list, not this record. */
export const INTENT_EXECUTOR_REGISTRY: Record<IntentAction['type'], IntentExecutor> = {
  SUPPORT_FLAG: SUPPORT_FLAG_EXECUTOR,
  HUMAN_SUPPORT_PROMPT: HUMAN_SUPPORT_PROMPT_EXECUTOR,
  SAFETY_MESSAGE: SAFETY_MESSAGE_EXECUTOR,
  GROUNDING: GROUNDING_EXECUTOR,
  RECOMMEND_RESOURCE: RECOMMEND_RESOURCE_EXECUTOR,
  RECOMMEND_ACTIVITY: RECOMMEND_ACTIVITY_EXECUTOR,
};

/**
 * Runs an intent's actions in configured order, mutates the AI result,
 * persists the SUPPORT_FLAG side effects, and returns explainability notes.
 * One executor failure never aborts the rest (logged, recorded as a note).
 */
export async function applyIntentVerdict(
  verdict: IntentVerdict,
  ctx: IntentApplyContext,
): Promise<string[]> {
  const notes: string[] = [...verdict.notes];
  for (const action of verdict.actions) {
    const executor = INTENT_EXECUTOR_REGISTRY[action.type];
    if (!executor) {
      notes.push(`No executor registered for action ${String(action.type)}.`);
      continue;
    }
    try {
      await executor.execute(action, verdict, ctx, notes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Executor ${action.type} failed: ${message}`);
      logger.warn(
        `Intent executor ${action.type} failed for conversation ${ctx.conversationId}: ${message}`,
      );
    }
  }

  // Mirror the verdict into the AI result so every consumer (message payload,
  // humanCareRecommendation, dashboards) sees a coherent flagged state —
  // independent of which individual executors succeeded.
  ctx.result.supportFlag = {
    candidate: true,
    category: verdict.category,
    severity: verdict.severity,
  };
  return notes;
}

function flagSummary(verdict: IntentVerdict, ctx: IntentApplyContext): string {
  const excerpt = ctx.userContent.slice(0, 180).replace(/\s+/g, ' ').trim();
  const studentLine = `Student ${ctx.studentRef ?? 'Unknown'}${
    ctx.classLabel ? ` (${ctx.classLabel})` : ''
  }. `;
  const descriptionLine = verdict.intentDescription
    ? `${verdict.intentDescription} `
    : '';
  const keywordLine = verdict.keywordEvidence.length
    ? `Matched keywords: ${verdict.keywordEvidence.join(', ')}. `
    : '';
  const actionLine = `Actions: ${verdict.actions.map((a) => String(a.type)).join(', ')}.`;
  return `${studentLine}${descriptionLine}Detected by ${verdict.matchedBy}. ${keywordLine}Student message: "${excerpt}". ${actionLine}`;
}
