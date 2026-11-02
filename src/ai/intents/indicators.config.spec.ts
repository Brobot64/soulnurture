import { readFileSync } from 'node:fs';
import { IndicatorLevel } from '@prisma/client';
import { INDICATOR_RULES, indicatorRuleById } from './indicators.config.js';

/** Every number anywhere in the catalogue, however deeply nested. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(numbersIn);
  }
  return [];
}

describe('Doc A indicator catalogue — nothing fires without a reviewer', () => {
  it('registers the reviewed code space exactly once', () => {
    const ids = INDICATOR_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'IND-A01',
      'IND-A02',
      'IND-B01',
      'IND-B02',
      'IND-B03',
      'IND-B04',
      'IND-B05',
      'IND-C01',
      'IND-C02',
      'IND-C03',
      'IND-C04',
      'IND-C05',
      'IND-U01',
    ]);
  });

  it('ships every rule unconfigured, so no surface can raise an indicator from it', () => {
    expect(INDICATOR_RULES.filter((rule) => rule.configured)).toEqual([]);
  });

  it('carries no numeric threshold, window or count anywhere (prohibition 1)', () => {
    expect(numbersIn(INDICATOR_RULES)).toEqual([]);
  });

  it('keeps the level in the code and the level on the rule the same fact', () => {
    for (const rule of INDICATOR_RULES) {
      expect(rule.level).toBe(
        rule.id.slice('IND-'.length, 'IND-'.length + 1) as IndicatorLevel,
      );
    }
  });

  it('states what each unconfigured rule is waiting on', () => {
    for (const rule of INDICATOR_RULES) {
      expect(rule.blockedOn.trim().length).toBeGreaterThan(0);
    }
  });

  it('labels only the rules the reviewed text names, and quotes them verbatim', () => {
    const labelled = INDICATOR_RULES.filter((rule) => rule.label !== null);
    expect(labelled.map((rule) => rule.id)).toEqual(['IND-B01', 'IND-B02']);
    // Whitespace-normalised: the handoff wraps this sentence across lines, and a
    // line break is not a wording difference.
    const handoff = readFileSync('docs/EPIC-D-IMPLEMENTATION-PLAN.md', 'utf8').replace(
      /\s+/g,
      ' ',
    );
    for (const rule of labelled) {
      expect(handoff).toContain(rule.label as string);
    }
  });

  it('looks a rule up by code and says so when the code is not the catalogue', () => {
    expect(indicatorRuleById('IND-U01')?.level).toBe(IndicatorLevel.U);
    expect(indicatorRuleById('IND-D01')).toBeUndefined();
  });
});
