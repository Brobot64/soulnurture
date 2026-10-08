import { randomInt } from 'node:crypto';

export const SHORT_CODE_LENGTH = 6;

// Unambiguous set — no O/0, I/1/L confusion so codes can be read aloud
// by school admins without transcription errors.
const ALPHANUMERIC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  }
  return out;
}

function acronymOf(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3);
  return words
    .map((word) => word[0])
    .join('')
    .slice(0, 3);
}

/// Candidate school short code: letters from the school acronym (up to 3)
/// padded to 6 characters with random alphanumerics. Callers retry on
/// unique-constraint conflicts.
export function generateShortCode(name: string): string {
  const acronym = acronymOf(name).slice(0, SHORT_CODE_LENGTH);
  return acronym + randomSuffix(SHORT_CODE_LENGTH - acronym.length);
}

/// Student onboarding code scoped to a school: <SHORTCODE>-<4 digits>.
/// Callers retry on unique-constraint conflicts.
export function generateStudentCode(shortCode: string): string {
  let digits = '';
  for (let i = 0; i < 4; i += 1) {
    digits += String(randomInt(10));
  }
  return `${shortCode}-${digits}`;
}
