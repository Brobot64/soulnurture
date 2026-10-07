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
 * Detection is a realtime, offline heuristic stack (see
 * language-detector.service.ts): diacritics scan → Pidgin marker words →
 * franc trigram detection. No LLM ever sits in the realtime lane; the
 * async understanding lane (worker VERNACULAR job) is the only model step.
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

/** Reply-lane switch: 'openai-native' is the built default (the frontier
 * model replies in the vernacular directly); 'n-atlas-translate' is
 * pre-wired config only — the local N-ATLaS model translates and a
 * second pass replies, enabled after the pilot. */
export type VernacularReplyMode = 'openai-native' | 'n-atlas-translate';
export const DEFAULT_VERNACULAR_REPLY_MODE: VernacularReplyMode =
  'openai-native';

/** franc's ISO 639-3 codes for our canonical set. */
export const FRANC_ONLY_CODES = ['eng', 'yor', 'hau', 'ibo', 'pcm'] as const;

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
