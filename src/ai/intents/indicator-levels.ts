import { IndicatorLevel, SupportFlagSeverity } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * Which Doc A §3 level a condition belongs to — applied to a flag the intent
 * engine has *already* raised.
 *
 * This is a label on an event, not a trigger. Nothing here decides whether a
 * student gets escalated: by the time `levelForVerdict` runs, the keyword floor
 * or a rule-bound AI category has already fired in `intent-engine.service.ts`,
 * the flag is being written, and a TIER_3 alert has already gone out. So no
 * threshold, persistence window, count or risk score is being invented, which is
 * what §2 and §6 forbid. What is being stated is which row of §3's table the
 * condition that fired sits in.
 *
 * It is still safeguarding semantics written by a developer, so §14 applies
 * ("does not independently change psychological thresholds or safeguarding
 * logic") and the whole table below is submitted for the psychology reviewer's
 * signature. That is what `INTENT_LEVEL_MAPPING_VERSION` says out loud, and what
 * `support-flags.service.ts` surfaces as `levelProvenance`, so no staff surface
 * can present these levels as if an approved rule produced them.
 *
 * `indicators.config.ts` is untouched and every IND-* rule stays
 * `configured: false`. `ruleId` therefore stays null on all of these rows: §5
 * needs approved definitions and §11 needs `rule_version`,
 * `persistence_window`, `recipient_role`, `service_standard` and
 * `closure_authority` before a flag may claim a rule as its source. A level
 * alongside a fabricated rule id would be the exact misrepresentation §17 warns
 * against.
 *
 * Two decisions the Product Owner made on 2026-11-12, both recorded here because
 * they change what a staff chip means:
 *
 *  - **The alert tier is the fallback grade.** Where the intent table has nothing
 *    to say, the level is read off the severity the AI itself asserted:
 *    `TIER_1_MODERATE` → A, `TIER_2_HIGH` → B, `TIER_3_ACUTE` → C. That replaces
 *    the v1 rule that the two axes never touch (Doc A G1), and it makes Level A
 *    writable for the first time — which §3's A row ("No alert by default") does
 *    not obviously mean. So every tier-derived row declares it on the surface,
 *    through `levelSource: 'AI_TIER'`, and the chip never gets to look like a
 *    graded conclusion.
 *  - **`IndicatorLevel.U` is no longer written automatically.** An unbound model
 *    candidate used to be U because §3's U row is literally "cannot be reliably
 *    classified"; it is now graded by the tier the model proposed. The
 *    uncertainty does not vanish — it stays visible as `Raised by: Ai Candidate`
 *    and as `AI_TIER` provenance — but the U chip will read 0 for anything the
 *    engine raises, and only a hand-set level can put a row there.
 *
 * One caveat the reviewer should see: for an unbound candidate the engine
 * defaults the severity to `TIER_2_HIGH` when the model asserted none
 * (`intent-engine.service.ts` layer 3), so a tier-derived B can be our default
 * rather than the model's judgement. Nothing stored distinguishes the two today.
 *
 * The one genuinely contested row is `PROLONGED_LOW_MOOD` → B. Its keyword pack
 * contains "everyone is better off without me", which reads as suicide-related
 * and therefore C-ish under §3. It stays B because §3's B row is this intent's
 * own description ("recurring/persistent distress"), and because §4.1's
 * precedence already handles the C case: when a message carries both hopeless
 * language and a suicide keyword, `intent-engine.service.ts` picks the worst
 * matching intent, so that turn is graded C by `SUICIDAL_IDEATION`. Flagged for
 * the reviewer rather than settled here.
 * ---------------------------------------------------------------------------
 */

/**
 * Bump this whenever any row below changes. §11 asks every graded record to
 * carry the version of the logic that graded it, and `ruleVersion` is reserved
 * for an actual rule id, so the version travels with the flag through the audit
 * meta and the detail surface instead.
 */
export const INTENT_LEVEL_MAPPING_VERSION =
  'intent-level-mapping-v2-2026-11-12-pending-psychology-signature';

/**
 * §3's level per condition the engine can raise. Keyed by the intent id, which
 * is also the value written to `SupportFlag.category`.
 */
const LEVEL_BY_INTENT: Record<string, IndicatorLevel> = {
  // §3 C — "self-harm/suicide-related disclosure".
  SUICIDAL_IDEATION: IndicatorLevel.C,
  SELF_HARM: IndicatorLevel.C,
  // §3 C — "serious abuse, exploitation, neglect or violence".
  ABUSE_DISCLOSURE: IndicatorLevel.C,
  // §3 C — "credible serious threat".
  THREAT_OR_COERCION: IndicatorLevel.C,
  // §3 B — "recurring/persistent distress".
  PROLONGED_LOW_MOOD: IndicatorLevel.B,
  // §3 B — "difficulty coping".
  ACUTE_PANIC: IndicatorLevel.B,
};

/**
 * The AI's own escalation tier read as a §3 level, for the flags the intent
 * table has nothing to say about. Order matters: this is only ever reached when
 * no condition matched, so a named disclosure is never re-graded by a tier.
 */
const LEVEL_BY_SEVERITY: Record<SupportFlagSeverity, IndicatorLevel> = {
  [SupportFlagSeverity.TIER_1_MODERATE]: IndicatorLevel.A,
  [SupportFlagSeverity.TIER_2_HIGH]: IndicatorLevel.B,
  [SupportFlagSeverity.TIER_3_ACUTE]: IndicatorLevel.C,
};

/** Which of the two rules above produced a level. */
export type LevelOrigin = 'INTENT_MAPPING' | 'AI_TIER';

/**
 * The level for a verdict the engine just produced.
 *
 * The condition that fired wins; the tier the AI asserted fills the rest, so an
 * engine-raised flag always carries a level and the Unclassified chip counts only
 * rows that predate the backfill or came from outside the engine.
 */
export function levelForVerdict(verdict: {
  intentId: string | null;
  severity: SupportFlagSeverity;
}): IndicatorLevel {
  const fromCondition = verdict.intentId
    ? LEVEL_BY_INTENT[verdict.intentId]
    : undefined;
  return fromCondition ?? LEVEL_BY_SEVERITY[verdict.severity];
}

/**
 * What graded a stored flag, for the `levelSource` the detail surface shows.
 * Re-derived from the row rather than stored, because a backfilled row and a
 * freshly raised one have to report the same origin for the same inputs.
 */
export function levelOriginForFlag(flag: {
  intentId: string | null;
}): LevelOrigin {
  return flag.intentId && LEVEL_BY_INTENT[flag.intentId]
    ? 'INTENT_MAPPING'
    : 'AI_TIER';
}

/** The intents this file grades, for the spec that refuses silent gaps. */
export const MAPPED_INTENT_IDS = Object.keys(LEVEL_BY_INTENT);
