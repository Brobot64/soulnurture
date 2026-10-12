import { Injectable } from '@nestjs/common';
import { SupportFlagSeverity } from '@prisma/client';
import { INTENTS, MODEL_CANDIDATE_LABEL } from './intents.config.js';
import type { IntentAction, IntentDefinition } from './intents.config.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';

/**
 * Pure classification of one user message against the intent rules.
 * No I/O — persistence happens in intent-executors.ts (apply step).
 *
 * Priority rules (documented in intents.config.ts):
 *   1. SERVER_KEYWORDS matches always win and are never downgraded.
 *   2. Highest severity wins across multiple matches.
 *   3. AI categories can confirm/upgrade but never downgrade.
 *   4. Uncategorised model candidates still produce a verdict so the
 *      professional dashboard gets a triage flag (flag plus reason).
 */
export interface IntentVerdict {
  /** null when the model flagged without hitting any rule-bound intent. */
  intentId: string | null;
  intentLabel: string;
  intentDescription: string | null;
  matchedBy: 'SERVER_KEYWORDS' | 'AI_CATEGORY' | 'MODEL_CANDIDATE';
  severity: SupportFlagSeverity;
  /** SupportFlag.category written by the SUPPORT_FLAG executor. */
  category: string;
  /** The exact keyword(s) that fired — audit/clinical-review evidence. */
  keywordEvidence: string[];
  actions: IntentAction[];
  /** Explainability trail surfaced into the flag summary and logs. */
  notes: string[];
}

const SEVERITY_RANK: Record<SupportFlagSeverity, number> = {
  TIER_1_MODERATE: 1,
  TIER_2_HIGH: 2,
  TIER_3_ACUTE: 3,
};

function coerceSeverity(value: unknown): SupportFlagSeverity | null {
  return value === 'TIER_1_MODERATE' ||
    value === 'TIER_2_HIGH' ||
    value === 'TIER_3_ACUTE'
    ? value
    : null;
}

@Injectable()
export class IntentEngineService {
  evaluate(input: {
    userContent: string;
    aiResult: AiGenerationResult;
  }): IntentVerdict | null {
    const haystack = normalizeForMatch(input.userContent ?? '');
    const modelFlag = input.aiResult?.supportFlag;
    const modelCategory =
      modelFlag?.category && modelFlag.category !== 'NONE'
        ? modelFlag.category
        : null;
    const modelSeverity = coerceSeverity(modelFlag?.severity);

    // Layer 1 — server keywords (runs on every message, AI available or not).
    const keywordMatches: { intent: IntentDefinition; evidence: string[] }[] = [];
    for (const intent of INTENTS) {
      const evidence = intent.serverSignals.keywords.filter((keyword) =>
        containsPhrase(haystack, keyword),
      );
      if (evidence.length > 0) keywordMatches.push({ intent, evidence });
    }

    if (keywordMatches.length > 0) {
      const worst = keywordMatches.reduce((a, b) =>
        SEVERITY_RANK[b.intent.severity] >= SEVERITY_RANK[a.intent.severity]
          ? b
          : a,
      );
      const severity = maxSeverity(worst.intent.severity, modelSeverity);
      const notes = [
        `Server keyword match on intent ${worst.intent.id}: ${worst.evidence.join(', ')}.`,
        modelFlag?.candidate === true
          ? `AI also proposed candidate=${modelFlag.candidate}${modelCategory ? `, category=${modelCategory}` : ''}${modelSeverity ? `, severity=${modelSeverity}` : ''}; server layer cannot be downgraded.`
          : 'AI did not propose a flag; server keyword layer escalated independently.',
      ];
      return {
        intentId: worst.intent.id,
        intentLabel: worst.intent.label,
        intentDescription: worst.intent.description,
        matchedBy: 'SERVER_KEYWORDS',
        severity,
        category: worst.intent.id,
        keywordEvidence: keywordMatches.flatMap((m) => m.evidence),
        actions: worst.intent.actions,
        notes,
      };
    }

    // Layer 2 — AI-confirmed categories against a rule-bound intent.
    if (modelFlag?.candidate === true && modelCategory) {
      const categoryMatches = INTENTS.filter((intent) =>
        intent.serverSignals.aiCategories.includes(modelCategory),
      );
      if (categoryMatches.length > 0) {
        const worst = categoryMatches.reduce((a, b) =>
          SEVERITY_RANK[b.severity] >= SEVERITY_RANK[a.severity] ? b : a,
        );
        const severity = maxSeverity(worst.severity, modelSeverity);
        return {
          intentId: worst.id,
          intentLabel: worst.label,
          intentDescription: worst.description,
          matchedBy: 'AI_CATEGORY',
          severity,
          category: worst.id,
          keywordEvidence: [],
          actions: worst.actions,
          notes: [
            `AI proposed category ${modelCategory} which is rule-bound to intent ${worst.id}; severity locked to ${severity}.`,
          ],
        };
      }
    }

    // Layer 3 — model candidate without a rule binding: persist for triage.
    if (modelFlag?.candidate === true) {
      return {
        intentId: null,
        intentLabel: MODEL_CANDIDATE_LABEL,
        intentDescription: null,
        matchedBy: 'MODEL_CANDIDATE',
        severity: modelSeverity ?? SupportFlagSeverity.TIER_2_HIGH,
        category: modelCategory ?? 'NONE',
        keywordEvidence: [],
        actions: [{ type: 'SUPPORT_FLAG' }],
        notes: [
          'AI proposed a safeguarding flag without a rule-bound category; persisted for professional triage.',
        ],
      };
    }

    return null;
  }
}

/**
 * Match-time normalisation, applied to both the student's text and every
 * keyword: lowercase, curly apostrophes straightened, combining marks stripped
 * (so "mo fẹ́ pa ara mi" and "mo fe pa ara mi" are the same phrase), whitespace
 * collapsed. Keyword lists stay in their written form.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-phrase match: the phrase must not be part of a longer word, so
 * "wish i was dead" does not fire inside "wish i was deadline". */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(
    haystack,
  );
}

function maxSeverity(
  a: SupportFlagSeverity,
  b: SupportFlagSeverity | null,
): SupportFlagSeverity {
  if (!b) return a;
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}
