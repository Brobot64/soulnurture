import { IndicatorLevel } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * INDICATORS — the Doc A rule catalogue (`IND-A01…IND-U01`).
 *
 * This file records which rules exist, at which level, and what each one is
 * waiting for. It is NOT a firing configuration: every rule here is
 * `configured: false`, so no indicator is produced by anything in this file and
 * the existing keyword floor in `intents.config.ts` stays the only automatic
 * safety net.
 *
 * The reviewed handoff ("Indicator Rules & Escalation Rules", Draft v0.1) is
 * signed by the psychology reviewer — Prof. Ejike Mgbenkemdi, 25 October 2026,
 * sections ALL, "Reviewed and approved for development". That signature is what
 * makes this catalogue citable. It is not what switches a rule on, and the
 * document says so in its own words:
 *
 *  - §5 heads the catalogue "These are candidate rules… The psychologist and
 *    safeguarding lead must approve exact definitions, wording, thresholds,
 *    recipients and response expectations", and requires "repeated",
 *    "persistent", "significant" and "immediate" to be operationally defined
 *    before production.
 *  - §2 and §6 forbid inventing cut-offs: no numeric threshold, persistence
 *    window or risk score until a qualified professional specifies and validates
 *    it. §5 IND-U01 repeats this for confidence.
 *  - §16 records no safeguarding reviewer, no safeguarding review date, no
 *    school-specific routes tested, and no document version in the approval
 *    block — and the approval statement limits itself to "the scope and version
 *    recorded here".
 *  - §17: "Do not launch with placeholder contacts, unapproved thresholds,
 *    unmonitored escalation queues or untested emergency routes."
 *
 * So `configured: false` is the approved state, not an unfinished one. The
 * §11 fields a rule must carry before it can fire — `rule_version`,
 * `trigger_definition`, `persistence_window`, `severity/impact definition`,
 * `missing-data behaviour`, `response_template_id`, `recipient_role`,
 * `backup_route_id`, `service_standard`, `closure_authority` — are deliberately
 * absent here rather than filled with developer defaults.
 *
 * One §4 requirement is already met and does not wait on anyone: precedence.
 * An urgent trigger outranks a lower signal in the same turn, and the AI can
 * never downgrade a server keyword match — `intent-engine.service.ts` and its
 * specs ("the model can never downgrade a server keyword match", "highest
 * severity wins when several intents match keywords") cover §4.1 and §12's
 * no-suppression criterion, including the T-04 bullying-plus-threat case.
 *
 * Levels are a dimension of their own, never derived from `SupportFlagSeverity`
 * (G1), and Level U means the evidence is unclear or conflicting — it is never
 * rendered as a milder shade of A (§3, prohibition 8).
 *
 * A `label` is null where the reviewed handoff names the rule only by its code.
 * §5 does describe each condition, but calls the description candidate wording
 * awaiting approval, so quoting it into a staff surface would present a draft
 * as signed-off copy — the failure Doc A exists to prevent.
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
    blockedOn:
      'D1: §5 carries this condition as candidate wording and §9 as a draft response pattern; neither is approved copy. Level A never means safe (§3).',
  },
  {
    id: 'IND-A02',
    level: IndicatorLevel.A,
    label: null,
    evidence: ['AI_CATEGORY'],
    configured: false,
    blockedOn:
      'D1: §5 wording is candidate, and a single AI category is not sufficient evidence for a graded conclusion (§2). Level A never means safe (§3).',
  },
  {
    id: 'IND-B01',
    level: IndicatorLevel.B,
    label: 'distress recurring/persistent',
    evidence: [...CHECKIN],
    configured: false,
    blockedOn:
      'D5: §6 makes the approved rule define the time window, the number and type of reports, the data source and missing-data handling, and §5 requires "persistent" to be operationally defined before production.',
  },
  {
    id: 'IND-B02',
    level: IndicatorLevel.B,
    label: 'interference with school, relationships, sleep, functioning',
    evidence: [...CHECKIN],
    configured: false,
    blockedOn:
      'D5: §6 treats a self-reported intensity rating as one contextual input that cannot establish safety, and leaves which captured answers count as interference unapproved.',
  },
  {
    id: 'IND-B03',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn:
      'D1 wording and D5 thresholds: §5 requires "repeated" to be operationally defined; consumes the CP answers staged in Slice 3.',
  },
  {
    id: 'IND-B04',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn:
      'CP-16 wording is reviewable but unsigned. §5 sends threats, violence and abuse over to C, and the keyword floor already fires there.',
  },
  {
    id: 'IND-B05',
    level: IndicatorLevel.B,
    label: null,
    evidence: [...CHECKIN],
    configured: false,
    blockedOn:
      'D1 wording and D5 thresholds: §5 states grief alone is not a disorder or an automatic high-risk indicator, so "ongoing" needs a professional definition.',
  },
  ...['C01', 'C02', 'C03', 'C04', 'C05'].map((suffix) => ({
    id: `IND-${suffix}`,
    level: IndicatorLevel.C,
    label: null,
    evidence: ['MESSAGE_KEYWORDS', 'AI_CATEGORY'] as IndicatorEvidence[],
    configured: false as const,
    blockedOn:
      'D8: §8 needs a named recipient role, a tested backup route and an acknowledgement standard per school, and §16 leaves the safeguarding reviewer, the review date and the routes-tested line blank. §17 forbids unmonitored queues and untested emergency routes. C is never auto-closed (§2).',
  })),
  {
    id: 'IND-U01',
    level: IndicatorLevel.U,
    label: null,
    evidence: [...CHECKIN, 'AI_CATEGORY'],
    configured: false,
    blockedOn:
      '§5 forbids unvalidated confidence thresholds and §8 forbids converting uncertainty into Level A by default, so this needs an approved uncertainty policy plus a safety-relevant prompt that is askable; CP-09…CP-17 are BLOCKED.',
  },
];

/** The rules a surface may show as evidence, never as a decision. */
export function indicatorRuleById(id: string): IndicatorRule | undefined {
  return INDICATOR_RULES.find((rule) => rule.id === id);
}
