import { INTENTS } from '../intents/intents.config.js';

/**
 * Low-sensitivity filter for session-summary text (Phase C step 3).
 *
 * Summaries live in the pgvector memory and are replayed into later
 * conversations, so they must never carry: diagnoses or clinical labels,
 * medication talk, secrets the student asked to keep, or verbatim crisis
 * wording (the safeguarding keywords themselves — quoting them back into a
 * future chat would both re-traumatise and leak the keyword list).
 *
 * Sentences that trip a pattern are dropped; the caller decides what to do
 * when everything was dropped (summary → fallback copy, hook → null).
 */

const SUMMARY_BANNED_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: 'diagnosis/clinical label',
    pattern:
      /\b(diagnos\w*|clinical depression|major depressive disorder|you have (an? )?\w+ disorder)\b/i,
  },
  {
    label: 'medication',
    pattern: /\b(prescrib\w*|medication|dosage|\d+\s?mg)\b/i,
  },
  {
    label: 'secrecy request',
    pattern:
      /\b(secret|do not tell anyone|don't tell anyone|confidential|between you and me)\b/i,
  },
];

// Verbatim-trauma guard: any sentence repeating a safeguarding keyword is
// dropped. Built once from the intent config so the two never drift apart.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CRISIS_KEYWORD_PATTERN = new RegExp(
  `\\b(${INTENTS.flatMap((intent) => intent.serverSignals.keywords)
    .map(escapeRegExp)
    .join('|')})\\b`,
  'i',
);

export interface FilteredSummaryText {
  text: string | null;
  notes: string[];
}

export function filterSummaryText(text: string): FilteredSummaryText {
  const notes: string[] = [];
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const kept = sentences.filter((sentence) => {
    const hit = SUMMARY_BANNED_PATTERNS.find((rule) =>
      rule.pattern.test(sentence),
    );
    if (hit) {
      notes.push(`Dropped summary sentence (${hit.label}) per summary guard.`);
      return false;
    }
    if (CRISIS_KEYWORD_PATTERN.test(sentence)) {
      notes.push(
        'Dropped summary sentence (crisis wording) per summary guard.',
      );
      return false;
    }
    return true;
  });

  if (kept.length === 0) {
    return { text: null, notes };
  }
  return { text: kept.join(' '), notes };
}
