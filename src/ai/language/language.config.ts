/**
 * ---------------------------------------------------------------------------
 * Language layer constants (Phase C step 4).
 *
 * The product officially supports English + four Nigerian languages:
 *   en  English
 *   pcm Nigerian Pidgin
 *   yo  Yoruba
 *   ha  Hausa
 *   ig  Igbo
 *
 * Detection is a heuristic stack (see language-detector.service.ts):
 * diacritics scan → Pidgin marker words → Yoruba/Hausa/Igbo lexicon
 * wordlists → franc trigram detection (long English only — franc cannot
 * separate yo/ha/ig: "mi o ti jeun lati aaro" scores ibo 1.0 vs yor 0.89) →
 * N-ATLaS itself, only when every heuristic is silent (LANG_ID_016: Hausa/
 * Igbo typed without diacritics is invisible to the wordlists). The model
 * stage is fail-open and capped by a short timeout — when it is missing,
 * slow or wrong, the preference fallback stands exactly as before.
 * ---------------------------------------------------------------------------
 */

export const SUPPORTED_LANGUAGES = ['en', 'pcm', 'yo', 'ha', 'ig'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Languages with a locally-hosted ASR model (NCAIR1 fine-tunes served by
 * the n-atlas-asr sidecar, Phase C step 5). English and Nigerian Pidgin
 * ride the Whisper chain instead: Pidgin is lexified on English and the
 * sidecar has no Pidgin checkpoint, so auto-detect Whisper handles it.
 */
export const ASR_VERNACULAR_LANGUAGES = ['yo', 'ha', 'ig'] as const;
export type AsrVernacularLanguage = (typeof ASR_VERNACULAR_LANGUAGES)[number];

export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba',
  ha: 'Hausa',
  ig: 'Igbo',
};

/** Reply-lane switch. 'n-atlas-translate' (default): generation stays
 * English (full context + guardrails on English) and local N-ATLaS renders
 * the finished reply into the turn's language in the same request — the
 * student's next reply comes back in their language immediately.
 * 'openai-native': the frontier model replies in the vernacular directly
 * (rollback switch — the hosted N-ATLaS endpoint scales to zero). */
export type VernacularReplyMode = 'openai-native' | 'n-atlas-translate';
export const DEFAULT_VERNACULAR_REPLY_MODE: VernacularReplyMode =
  'n-atlas-translate';

/** franc's ISO 639-3 codes for our canonical set. */
export const FRANC_ONLY_CODES = ['eng', 'yor', 'hau', 'ibo', 'pcm'] as const;

/**
 * franc is only trusted for English, and only on text long enough to give
 * its trigram model signal. On Nigerian-language text it misfires badly
 * ("mi o ti jeun lati aaro mo fe lo ile mi" → ibo 1.0 vs yor 0.89; even
 * "I am happy" → hau), so anything franc asserts about yo/ha/ig/pcm is
 * discarded — the lexicon below is the only source for those languages.
 */
export const FRANC_MIN_CHARS = 20;
export const FRANC_ACCEPTED_CODE = 'eng';

/** Below this trimmed length the detector never asks the model (see the
 * model stage in language-detector.service.ts): one or two words cannot be
 * classified reliably, so the preference fallback stands unchanged. */
export const IDENTIFY_MIN_CHARS = 8;

export const FRANC_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  eng: 'en',
  yor: 'yo',
  hau: 'ha',
  ibo: 'ig',
  pcm: 'pcm',
};

/**
 * Distinctive marked letters per language. Yoruba ẹ/ọ/ṣ, Hausa ƙ/ɓ/ɗ and
 * Igbo ị/ọ/ụ/ṅ are what diacritic typing reveals immediately. 'ọ' is shared
 * between Yoruba and Igbo, so a score tie (shared letter only) falls through
 * to the next detection stage instead of guessing.
 */
export const DIACRITIC_SETS: Record<'yo' | 'ha' | 'ig', readonly string[]> = {
  yo: ['ẹ', 'ọ', 'ṣ'],
  ha: ['ƙ', 'ɓ', 'ɗ'],
  ig: ['ị', 'ọ', 'ụ', 'ṅ'],
};

/**
 * Nigerian Pidgin markers. franc classifies Pidgin as English (it is
 * lexified on English), so this wordlist is the primary Pidgin signal.
 * Matching is whole-token; two distinct markers are required before the
 * detector commits (one marker is noise, three is confident).
 */
export const PIDGIN_MARKERS = [
  'abeg',
  'dey',
  'wetin',
  'sabi',
  'wahala',
  'sha',
  'nau',
  'abi',
  'shey',
  'oga',
  'una',
  'jare',
  'sef',
  'waka',
  'yarn',
  'gist',
  'chop',
  'comot',
] as const;

/** Multi-word Pidgin phrases; component words are deliberately not in
 * PIDGIN_MARKERS so a phrase can never double-count with a token. */
export const PIDGIN_MARKER_PHRASES = [
  'no vex',
  'how far',
  'make i',
  'small small',
  'well well',
  'e don',
] as const;

export const PIDGIN_MIN_MARKERS = 2;
export const PIDGIN_HIGH_MARKERS = 3;

/**
 * Yoruba/Hausa/Igbo lexicon wordlists — the primary signal for the three
 * local languages, because franc cannot separate them (see FRANC_MIN_CHARS).
 * Every entry is whole-token matched on lowercased text and must be
 * unambiguous across our five languages + English: shared words ('obi'
 * yo+ig, 'iya' yo+ha, 'ni' yo+ha, 'ego', 'son') are deliberately absent.
 * Diacritic spellings are handled by the (earlier, higher-precision)
 * diacritics stage, so entries are written plain.
 *
 * Scoring per matched token occurrence: 3+ letters = 1.0, 2-letter words =
 * 0.5 — and only Yoruba carries 2-letter words (mi/mo/fe/lo things);
 * a 2-letter hit can never clear the threshold alone.
 */
export const LEXICON_WORDS: Record<'yo' | 'ha' | 'ig', readonly string[]> = {
  yo: [
    'aaro',
    'baba',
    'ile',
    'iwe',
    'jeun',
    'lati',
    'loni',
    'nkan',
    'omi',
    'ounje',
    'owo',
    // 2-letter (0.5 each, occurrence-counted)
    'fe',
    'ko',
    'lo',
    'mi',
    'mo',
    'se',
  ],
  ha: [
    'abinci',
    'daga',
    'gida',
    'gobe',
    'ina',
    'jiya',
    'kada',
    'kwana',
    'menene',
    'nagode',
    'nawa',
    'ruwa',
    'yaya',
    'yanzu',
  ],
  ig: [
    'akwukwo',
    'ebee',
    'gini',
    'maka',
    'mmiri',
    'ndewo',
    'nke',
    'nna',
    'nne',
    'nri',
    'nwa',
    'nwanne',
    'oge',
    'ulo',
  ],
};

/** Accept a lexicon call only at this score, and only when strictly the
 * highest language. "mi o ti jeun lati aaro mo fe lo ile mi" scores yo 6.5;
 * a single 3-letter word (1.0) or two 2-letter words (1.0) never fire. */
export const LEXICON_MIN_SCORE = 2.5;
export const LEXICON_HIGH_SCORE = 5.0;

/** System-prompt language line. Vernacular directives demand a fully
 * vernacular reply — natural and culturally grounded, never machine-literal,
 * reusing the student's own vocabulary. Unknown codes fall back to English. */
export function languagePromptDirective(code: string | null | undefined): string {
  const supported: SupportedLanguage = SUPPORTED_LANGUAGES.includes(
    code as SupportedLanguage,
  )
    ? (code as SupportedLanguage)
    : 'en';
  const name = LANGUAGE_DISPLAY_NAMES[supported];
  if (supported === 'en') {
    return `Language: ${name} — reply in ${name}.`;
  }
  return (
    `Language: ${name} — REPLY FULLY in ${name}. ` +
    `Write natural, culturally grounded ${name} (never machine-literal), ` +
    `and keep the student's own vocabulary where you can.`
  );
}
