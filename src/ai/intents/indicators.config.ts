import { IndicatorLevel } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * INDICATORS — the Doc A rule catalogue (`IND-A01…IND-U01`).
 *
 * This file records which rules exist, at which level, and what each one is
 * waiting for. It is NOT a firing configuration: every rule here is
 * `configured: false`, so no indicator is produced by anything in this file and
 * the existing keyword floor in `intents.config.ts` stays the only automatic
 * safety net. That is deliberate (Doc A prohibition 1): a rule whose trigger is
 * "repeated", "persistent", "significant" or "immediate" needs a number that
 * only the psychologist can set (open decision D5), and a rule whose wording
 * was never supplied needs the wording itself (D1).
 *
 * Levels are a dimension of their own, never derived from `SupportFlagSeverity`
 * (G1), and Level U means the evidence is unclear or conflicting — it is never
 * rendered as a milder shade of A (§3, prohibition 8).
 *
 * A `label` is null where the reviewed handoff names the rule only by its code.
 * Inventing a label would present developer guesswork as signed-off copy, which
 * is the failure Doc A exists to prevent.
 * ---------------------------------------------------------------------------
 */

/** Where a rule takes its evidence from, per Doc A §4. */
export type IndicatorEvidence = 'MESSAGE_KEYWORDS' | 'AI_CATEGORY' | 'CHECKIN_SIGNAL';

export interface IndicatorRule {
  /** Stable code from the reviewed catalogue, e.g. `IND-B01`. */
  id: string;
  level: IndicatorLevel;
  /** Quoted name of the rule, or null when the reviewed text never gave one. */
  label: string | null;
  evidence: IndicatorEvidence[];
  /** Every rule in this file is false; `indicators.config.spec.ts` enforces it. */
  configured: false;
  /** The open decision this rule waits on, in the reviewer's own numbering. */
  blockedOn: string;
}

const CHECKIN = ['CHECKIN_SIGNAL'] as const;

export const INDICATOR_RULES: readonly IndicatorRule[] = [
  {
    id: 'IND-A01',
    level: IndicatorLevel.A,
    label: null,
    evidence: ['MESSAGE_KEYWORDS'],
    configured: false,
    blockedOn: 'D1: rule wording and student-facing label not supplied. A never means safe.',
  },
  {
    id: 'IND-A02',
    level: IndicatorLevel.A,
    label: null,
    evidence: ['AI_CATEGORY'],
    configured: false,
    blockedOn: 'D1: rule wording and student-facing label not supplied. A never means safe.',
  },
  {
    id: 'IND-B01',
    level: IndicatorLevel.B,
    label: 'distress recurring/persistent',
    evidence: [...CHECKIN],
    configured: false,
    blockedOn: 'D5: the recurrence window is a psychologist decision, not a developer default.',
  },
  {
    id: 'IND-B02',
    level: IndicatorLevel.B,
    label: 'interference with school, relationships, sleep, functioning',
    evidence: [...CHECKIN],
    configured: false,
    blockedOn: 'D5: which captured answers count as interference, and how many, is unapproved.',
  },
  {
    id: 'IND-B03',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn: 'D1 wording and D5 thresholds: consumes the CP answers staged in Slice 3.',
  },
  {
    id: 'IND-B04',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn: 'CP-16 wording is reviewable but unsigned; the keyword floor already covers C.',
  },
  {
    id: 'IND-B05',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn: 'D1 wording and D5 thresholds: consumes the CP answers staged in Slice 3.',
  },
  ...['C01', 'C02', 'C03', 'C04', 'C05'].map((suffix) => ({
    id: `IND-${suffix}`,
    level: IndicatorLevel.C,
    label: null,
    evidence: ['MESSAGE_KEYWORDS', 'AI_CATEGORY'] as IndicatorEvidence[],
    configured: false as const,
    blockedOn: 'D8: school route config and named recipients are not placeholder-able. C is never auto-closed.',
  })),
  {
    id: 'IND-U01',
    level: IndicatorLevel.U,
    label: null,
    evidence: [...CHECKIN, 'AI_CATEGORY'],
    configured: false,
    blockedOn: 'Needs a safety-relevant prompt to be askable; CP-09…CP-17 are BLOCKED, and U has no confidence threshold to invent.',
  },
];

/** The rules a surface may show as evidence, never as a decision. */
export function indicatorRuleById(id: string): IndicatorRule | undefined {
  return INDICATOR_RULES.find((rule) => rule.id === id);
}
