import { SHORT_CODE_LENGTH, generateShortCode, generateStudentCode } from './short-code.js';

const CODE_CHARS = /^[A-HJKMNP-Z2-9]+$/; // unambiguous set — no O/0, I/1/L

describe('generateShortCode', () => {
  it('builds a 6-char code prefixed with the school acronym initials', () => {
    const code = generateShortCode('Government College Umuahia');
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code.startsWith('GCU')).toBe(true);
    expect(code).toMatch(CODE_CHARS);
  });

  it('uses the first letters of a single-word school name', () => {
    const code = generateShortCode('Baptist');
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code.startsWith('BAP')).toBe(true);
  });

  it('falls back to random fill when the name has no letters', () => {
    const code = generateShortCode('123 456');
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code).toMatch(CODE_CHARS);
  });

  it('truncates long acronyms to the code length', () => {
    const code = generateShortCode('Alpha Beta Gamma Delta');
    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    expect(code.startsWith('ABG')).toBe(true);
  });
});

describe('generateStudentCode', () => {
  it('scopes a 4-digit suffix under the school short code', () => {
    const code = generateStudentCode('GCU8K2');
    expect(code).toMatch(/^GCU8K2-\d{4}$/);
  });
});
