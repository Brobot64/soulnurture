import { IndicatorLevel, SupportFlagSeverity } from '@prisma/client';
import { INTENTS } from './intents.config.js';
import {
  INTENT_LEVEL_MAPPING_VERSION,
  MAPPED_INTENT_IDS,
  levelForVerdict,
  levelOriginForFlag,
} from './indicator-levels.js';

/**
 * The Doc A §3 grades that `intent-executors.ts` writes onto a flag.
 *
 * Two rules, in this order (Product Owner, 2026-11-12): the condition that fired
 * is graded by the §3 table, and the AI's own alert tier grades whatever the
 * table leaves. These assertions are what keep that order visible — the failure
 * mode is a tier quietly overriding a condition, which would make a suicide
 * disclosure graded by whatever the model happened to say about urgency.
 */

const graded = (
  intentId: string | null,
  severity: SupportFlagSeverity = SupportFlagSeverity.TIER_3_ACUTE,
) => ({ intentId, severity });

describe('the condition table grades what it covers', () => {
  it('grades every condition the engine can raise', () => {
    // An intent added without a row here is graded by its tier instead, which is
    // a different question — how urgent the model thought it was, not what the
    // student disclosed.
    const unmapped = INTENTS.map((intent) => intent.id).filter(
      (id) => !MAPPED_INTENT_IDS.includes(id),
    );
    expect(unmapped).toEqual([]);
  });

  it.each([
    ['SUICIDAL_IDEATION', IndicatorLevel.C],
    ['SELF_HARM', IndicatorLevel.C],
    ['ABUSE_DISCLOSURE', IndicatorLevel.C],
    ['THREAT_OR_COERCION', IndicatorLevel.C],
    ['PROLONGED_LOW_MOOD', IndicatorLevel.B],
    ['ACUTE_PANIC', IndicatorLevel.B],
  ])('puts %s at Level %s, per §3', (intentId, level) => {
    expect(levelForVerdict(graded(intentId))).toBe(level);
  });

  it('never lets a tier override a graded condition', () => {
    // The one assertion that used to keep the two axes fully independent. It now
    // pins precedence instead, because the fallback is real: a low-urgency
    // suicide-related flag is still Level C, and a screaming-urgent low mood is
    // still Level B.
    for (const severity of Object.values(SupportFlagSeverity)) {
      expect(levelForVerdict(graded('SELF_HARM', severity))).toBe(IndicatorLevel.C);
      expect(levelForVerdict(graded('PROLONGED_LOW_MOOD', severity))).toBe(
        IndicatorLevel.B,
      );
    }
  });
});

describe('the tier grades what the table cannot', () => {
  it.each([
    [SupportFlagSeverity.TIER_1_MODERATE, IndicatorLevel.A],
    [SupportFlagSeverity.TIER_2_HIGH, IndicatorLevel.B],
    [SupportFlagSeverity.TIER_3_ACUTE, IndicatorLevel.C],
  ])('reads %s as Level %s', (severity, level) => {
    // Only unbound candidates reach here — the engine's layer 3 is the sole
    // raiser of a flag with no intent id.
    expect(levelForVerdict(graded(null, severity))).toBe(level);
  });

  it('grades an unbound candidate by its tier, not as U', () => {
    // v1 of this mapping answered §3's "cannot be reliably classified" with U.
    // The owner replaced that with the tier the model asserted, so the
    // uncertainty now travels as provenance, and this is the row that proves it.
    expect(levelForVerdict(graded(null, SupportFlagSeverity.TIER_1_MODERATE))).toBe(
      IndicatorLevel.A,
    );
    expect(levelOriginForFlag({ intentId: null })).toBe('AI_TIER');
  });

  it('names the origin a reviewer has to see beside the level', () => {
    expect(levelOriginForFlag({ intentId: 'SELF_HARM' })).toBe('INTENT_MAPPING');
    expect(levelOriginForFlag({ intentId: 'NOT_IN_THE_TABLE' })).toBe('AI_TIER');
    expect(levelOriginForFlag({ intentId: null })).toBe('AI_TIER');
  });

  it('gives Level A a writer, and only through the tier', () => {
    // §3's A row is "No alert by default", so an A from a condition would be a
    // contradiction. An A here means the model itself called it moderate, and
    // `levelSource` says so out loud on the staff surface.
    const fromConditions = INTENTS.map((intent) =>
      levelForVerdict(graded(intent.id, SupportFlagSeverity.TIER_1_MODERATE)),
    );
    expect(fromConditions).not.toContain(IndicatorLevel.A);
    expect(levelForVerdict(graded(null, SupportFlagSeverity.TIER_1_MODERATE))).toBe(
      IndicatorLevel.A,
    );
  });
});

describe('the provenance §7.5 and §11 ask a graded record to carry', () => {
  it('names the version of the logic that graded it', () => {
    expect(INTENT_LEVEL_MAPPING_VERSION).toMatch(
      /^intent-level-mapping-v\d+-\d{4}-\d{2}-\d{2}/,
    );
  });

  it('says out loud that no reviewer has signed it yet', () => {
    // Bumping this string is the act of getting it signed. Until then every
    // level on screen has to declare itself provisional.
    expect(INTENT_LEVEL_MAPPING_VERSION).toContain('pending-psychology-signature');
  });
});
