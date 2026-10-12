import {
  genericReplyLine,
  holdingLine,
  safetyLine,
  SCRIPTED_SAFETY,
} from './scripted-copy.js';

const LOCAL = ['pcm', 'yo', 'ha', 'ig'] as const;
const SAFETY_INTENTS = [
  'SUICIDAL_IDEATION',
  'SELF_HARM',
  'ABUSE_DISCLOSURE',
  'THREAT_OR_COERCION',
] as const;

describe('scripted in-language copy (items 5 and 6)', () => {
  it('has a pre-approved safety line for every safety intent in every local language', () => {
    for (const intent of SAFETY_INTENTS) {
      for (const lang of LOCAL) {
        const line = SCRIPTED_SAFETY[intent]?.[lang];
        expect(line, `${intent}/${lang}`).toBeTruthy();
      }
    }
  });

  it('returns the in-language safety line instead of the English default', () => {
    const english = 'English default';
    expect(safetyLine('SUICIDAL_IDEATION', 'ha', english)).toBe(
      SCRIPTED_SAFETY.SUICIDAL_IDEATION?.ha,
    );
    expect(safetyLine('SUICIDAL_IDEATION', 'ha', english)).not.toBe(english);
  });

  it('keeps the English default for English turns and for intents without a scripted line', () => {
    expect(safetyLine('SUICIDAL_IDEATION', 'en', 'English default')).toBe('English default');
    expect(safetyLine('ACUTE_PANIC', 'yo', 'English default')).toBe('English default');
  });

  it('gives every local language a holding line that differs from English', () => {
    for (const lang of LOCAL) {
      const line = holdingLine(lang, 'English holding');
      expect(line, lang).not.toBe('English holding');
      expect(line.length).toBeGreaterThan(20);
    }
  });

  it('uses the configured English holding line for English turns', () => {
    expect(holdingLine('en', 'Configured English holding')).toBe(
      'Configured English holding',
    );
  });

  it('gives every local language a generic in-language reply for total render failure', () => {
    for (const lang of LOCAL) {
      const line = genericReplyLine(lang);
      expect(line, lang).toBeTruthy();
      expect(line.length).toBeGreaterThan(10);
    }
  });
});
