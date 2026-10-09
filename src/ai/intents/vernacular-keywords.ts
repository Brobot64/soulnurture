/**
 * ---------------------------------------------------------------------------
 * VERNACULAR KEYWORD PACKS (Phase C step 4).
 *
 * Starter safeguarding keywords for Yoruba, Hausa, Igbo and Nigerian
 * Pidgin, merged into the intent engine's server layer (intents.config.ts).
 * The engine folds diacritics (see foldDiacritics) before substring
 * matching, so marked and unmarked spellings of a term both hit — the
 * explicit ASCII variants below stay listed so the clinical reviewer sees
 * both spellings side by side. Every term is stored lowercase.
 *
 * REVIEW STATUS: PENDING_CLINICAL_REVIEW — the clinical reviewer must sign
 * off (or amend) every term and gloss. Until then these act as a safety
 * floor alongside the English keyword sets; they surface, together with
 * the English terms, through GET /api/v1/ai/config.
 * ---------------------------------------------------------------------------
 */

export type VernacularLanguageCode = 'yo' | 'ha' | 'ig' | 'pcm';

export interface VernacularKeyword {
  /** Lowercase term; the engine substring-matches it against userContent. */
  term: string;
  language: VernacularLanguageCode;
  /** English meaning — reviewer-facing, never shown to students. */
  gloss: string;
}

export const VERNACULAR_KEYWORD_REVIEW_STATUS = 'PENDING_CLINICAL_REVIEW';

export const VERNACULAR_KEYWORDS: Record<string, VernacularKeyword[]> = {
  SUICIDAL_IDEATION: [
    { term: 'mo fẹ́ kú', language: 'yo', gloss: 'I want to die' },
    { term: 'mo fe ku', language: 'yo', gloss: 'I want to die (no diacritics)' },
    { term: 'kí n kú', language: 'yo', gloss: 'let me die' },
    { term: 'ki n ku', language: 'yo', gloss: 'let me die (no diacritics)' },
    { term: 'ẹ̀mí mi ti tán', language: 'yo', gloss: 'my life is over' },
    {
      term: 'emi mi ti tan',
      language: 'yo',
      gloss: 'my life is over (no diacritics)',
    },
    { term: 'ina son in mutu', language: 'ha', gloss: 'I want to die' },
    { term: 'in kashe kaina', language: 'ha', gloss: 'I will kill myself' },
    { term: 'na gaji da rayuwa', language: 'ha', gloss: 'I am tired of life' },
    { term: 'achọrọ m ịnwụ', language: 'ig', gloss: 'I want to die' },
    {
      term: 'achoro m inwu',
      language: 'ig',
      gloss: 'I want to die (no diacritics)',
    },
    { term: 'gbuo onwe m', language: 'ig', gloss: 'kill myself' },
    { term: 'ndụ m agwụla', language: 'ig', gloss: 'my life is finished' },
    {
      term: 'ndu m agwula',
      language: 'ig',
      gloss: 'my life is finished (no diacritics)',
    },
    { term: 'i wan die', language: 'pcm', gloss: 'I want to die' },
    { term: 'make i die', language: 'pcm', gloss: 'let me die' },
    { term: 'i don tire for life', language: 'pcm', gloss: 'I am tired of life' },
    {
      term: 'this life no worth it',
      language: 'pcm',
      gloss: 'this life is not worth living',
    },
  ],
  SELF_HARM: [
    { term: 'mo fẹ́ pa ara mi', language: 'yo', gloss: 'I want to kill myself' },
    {
      term: 'mo fe pa ara mi',
      language: 'yo',
      gloss: 'I want to kill myself (no diacritics)',
    },
    { term: 'pa ara mi', language: 'yo', gloss: 'kill/harm myself' },
    { term: 'in cuta kaina', language: 'ha', gloss: 'I will cut myself' },
    { term: 'in cuci kaina', language: 'ha', gloss: 'I will hurt myself' },
    { term: 'na cuta kaina', language: 'ha', gloss: 'I cut myself' },
    { term: 'mmerụ onwe m', language: 'ig', gloss: 'harm to myself' },
    { term: 'mmeru onwe m', language: 'ig', gloss: 'harm to myself (no diacritics)' },
    { term: 'i wan wound myself', language: 'pcm', gloss: 'I want to wound myself' },
    { term: 'i go wound myself', language: 'pcm', gloss: 'I will wound myself' },
    { term: 'i wan cut myself', language: 'pcm', gloss: 'I want to cut myself' },
  ],
  ACUTE_PANIC: [
    { term: 'ọkàn mi ń lù', language: 'yo', gloss: 'my heart is pounding' },
    {
      term: 'okan mi n lu',
      language: 'yo',
      gloss: 'my heart is pounding (no diacritics)',
    },
    { term: 'zuciyata na bugawa', language: 'ha', gloss: 'my heart is racing' },
    { term: 'na rasa numfashi', language: 'ha', gloss: 'I am losing my breath' },
    {
      term: 'ba zan iya numfashi ba',
      language: 'ha',
      gloss: 'I cannot breathe',
    },
    { term: 'obi m na-akụ', language: 'ig', gloss: 'my heart is beating hard' },
    {
      term: 'obi m na-aku',
      language: 'ig',
      gloss: 'my heart is beating hard (no diacritics)',
    },
    {
      term: 'enweghị m ike iku ume',
      language: 'ig',
      gloss: 'I cannot breathe',
    },
    {
      term: 'enweghi m ike iku ume',
      language: 'ig',
      gloss: 'I cannot breathe (no diacritics)',
    },
    { term: 'i no fit breathe', language: 'pcm', gloss: 'I cannot breathe' },
    { term: 'my heart dey beat fast', language: 'pcm', gloss: 'my heart is racing' },
  ],
  PROLONGED_LOW_MOOD: [
    { term: 'ìrètí mi kò sí', language: 'yo', gloss: 'I have no hope' },
    { term: 'ireti mi ko si', language: 'yo', gloss: 'I have no hope (no diacritics)' },
    { term: 'inú mi kò dùn', language: 'yo', gloss: 'I am unhappy' },
    { term: 'inu mi ko dun', language: 'yo', gloss: 'I am unhappy (no diacritics)' },
    { term: 'babu bege', language: 'ha', gloss: 'there is no hope' },
    { term: 'na rasa bege', language: 'ha', gloss: 'I have lost hope' },
    {
      term: 'enweghị m olileanya',
      language: 'ig',
      gloss: 'I have no hope',
    },
    {
      term: 'enweghi m olileanya',
      language: 'ig',
      gloss: 'I have no hope (no diacritics)',
    },
    { term: 'obi adịghị m mma', language: 'ig', gloss: 'I am not happy' },
    {
      term: 'obi adighi m mma',
      language: 'ig',
      gloss: 'I am not happy (no diacritics)',
    },
    { term: 'nothing dey sweet me', language: 'pcm', gloss: 'nothing pleases me anymore' },
    { term: 'i dey feel down well well', language: 'pcm', gloss: 'I feel very down' },
    { term: 'sorrow dey kill me', language: 'pcm', gloss: 'sadness is overwhelming me' },
  ],
};

// The engine folds case on both sides, so this is config hygiene, not a
// match guard — fail loud at module load anyway: a mixed-case term reads
// as a typo in the pack the clinical reviewer signs off.
for (const [intentId, entries] of Object.entries(VERNACULAR_KEYWORDS)) {
  for (const entry of entries) {
    if (entry.term !== entry.term.toLowerCase()) {
      throw new Error(
        `Vernacular keyword must be lowercase: ${intentId} → "${entry.term}"`,
      );
    }
  }
}

/**
 * Case- and diacritic-insensitive fold applied to both the message and the
 * keywords before matching: "Mo fẹ́ kú" and "mo fe ku" must land on the same
 * term. NFD + combining-mark strip (U+0300–U+036F) erases tone marks and
 * the dotted-under letters (ẹ ọ ị ụ); the hooked Hausa letters (ƙ ɓ ɗ)
 * have no canonical decomposition and are mapped explicitly.
 */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ƙ/g, 'k')
    .replace(/ɓ/g, 'b')
    .replace(/ɗ/g, 'd');
}

/** Terms merged into the given intent's server keyword list. */
export function vernacularKeywordsFor(intentId: string): string[] {
  return (VERNACULAR_KEYWORDS[intentId] ?? []).map((entry) => entry.term);
}
