/**
 * ---------------------------------------------------------------------------
 * VERNACULAR KEYWORD PACKS (Phase C step 4).
 *
 * Starter safeguarding keywords for Yoruba, Hausa, Igbo and Nigerian
 * Pidgin, merged into the intent engine's server layer (intents.config.ts).
 * The engine matches these as lowercase substrings of the raw user message,
 * so every term is stored lowercase and diacritic + ASCII spellings are
 * listed separately — students type with and without diacritics.
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
    { term: 'igbu onwe m', language: 'ig', gloss: 'killing myself' },
    { term: 'ndụ m agwụla', language: 'ig', gloss: 'my life is finished' },
    {
      term: 'ndu m agwula',
      language: 'ig',
      gloss: 'my life is finished (no diacritics)',
    },
    {
      term: 'mí ò fẹ́ láàyè mí mọ́',
      language: 'yo',
      gloss: "I don't want my life anymore",
    },
    {
      term: 'mi o fe laye mi mo',
      language: 'yo',
      gloss: "I don't want my life anymore (no diacritics)",
    },
    {
      term: 'ba na son ina rayuwa',
      language: 'ha',
      gloss: "I don't want to live",
    },
    {
      term: 'achọghị m ịdị ndụ ọzọ',
      language: 'ig',
      gloss: 'I do not want to live anymore',
    },
    {
      term: 'achoghi m idibu ozo',
      language: 'ig',
      gloss: 'I do not want to live anymore (no diacritics)',
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
    {
      term: 'merụ onwe m ahụ',
      language: 'ig',
      gloss: 'hurt myself (harmful act)',
    },
    {
      term: 'meru onwe m ahu',
      language: 'ig',
      gloss: 'hurt myself (harmful act, no diacritics)',
    },
    {
      term: 'cuci kaina',
      language: 'ha',
      gloss: 'hurt myself',
    },
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
  // SAFETY_SUITE_001: packs for the two TIER_3 intents added with the dataset
  // regression suite, plus the vernacular corpus translations. Terms here were
  // drafted to match the vernacular-corpus.ts fixture rows; every term and
  // gloss is PENDING_NATIVE_REVIEW like the rest of this file.
  ABUSE_DISCLOSURE: [
    {
      term: 'kí n má sọ fún ẹnikẹ́ni',
      language: 'yo',
      gloss: '(told me) not to tell anyone',
    },
    {
      term: 'ki n ma so fun enikeni',
      language: 'yo',
      gloss: '(told me) not to tell anyone (no diacritics)',
    },
    { term: 'pa mí lára', language: 'yo', gloss: 'hurting me' },
    { term: 'pa mi lara', language: 'yo', gloss: 'hurting me (no diacritics)' },
    {
      term: 'ń lu mí nígbà tí',
      language: 'yo',
      gloss: 'hits me when',
    },
    {
      term: 'n lu mi nigba ti',
      language: 'yo',
      gloss: 'hits me when (no diacritics)',
    },
    { term: 'yana duka ni', language: 'ha', gloss: 'hits me (ongoing)' },
    { term: 'na-akụ m', language: 'ig', gloss: 'hits me' },
    { term: 'na aku m', language: 'ig', gloss: 'hits me (no hyphen)' },
    {
      term: 'pa àbúrò mi lára',
      language: 'yo',
      gloss: 'hurting my younger sibling',
    },
    {
      term: 'pa aburo mi lara',
      language: 'yo',
      gloss: 'hurting my younger sibling (no diacritics)',
    },
    {
      term: 'láì fún mi ní oúnjẹ',
      language: 'yo',
      gloss: 'without giving me food',
    },
    {
      term: 'lai fun mi ni ounje',
      language: 'yo',
      gloss: 'without giving me food (no diacritics)',
    },
    {
      term: 'firanṣẹ àwòrán aṣírí',
      language: 'yo',
      gloss: 'send private pictures',
    },
    {
      term: 'firanse aworan asiri',
      language: 'yo',
      gloss: 'send private pictures (no diacritics)',
    },
    { term: 'ìpàdé aṣírí', language: 'yo', gloss: 'secret meetings' },
    { term: 'ipade asiri', language: 'yo', gloss: 'secret meetings (no diacritics)' },
    {
      term: 'fi ọ̀rọ̀ ìbálòpọ̀',
      language: 'yo',
      gloss: 'with sexual words / advances',
    },
    {
      term: 'fi oro ibalopo',
      language: 'yo',
      gloss: 'with sexual words / advances (no diacritics)',
    },
    {
      term: 'lo ọ̀rẹ́ mi lọ́nà burúkú',
      language: 'yo',
      gloss: 'using my friend in a bad way',
    },
    {
      term: 'lo ore mi lona buruku',
      language: 'yo',
      gloss: 'using my friend in a bad way (no diacritics)',
    },
    {
      term: 'yóò mọ̀ pé mo sọ fún',
      language: 'yo',
      gloss: 'will find out that I told',
    },
    {
      term: 'yoo mo pe mo so fun',
      language: 'yo',
      gloss: 'will find out that I told (no diacritics)',
    },
    {
      term: 'kada in gaya wa kowa',
      language: 'ha',
      gloss: '(told me) not to tell anyone',
    },
    {
      term: 'yana ci min ciwo',
      language: 'ha',
      gloss: 'hurts me (ongoing)',
    },
    {
      term: 'aika masa hotunan sirri',
      language: 'ha',
      gloss: 'send him private pictures',
    },
    {
      term: 'cin dan uwana karami ciwo',
      language: 'ha',
      gloss: 'hurting my younger sibling',
    },
    {
      term: 'ganawar mu ta sirri',
      language: 'ha',
      gloss: 'our secret meetings',
    },
    {
      term: 'kwana da yawa ba tare da abinci ba',
      language: 'ha',
      gloss: 'for days without food',
    },
    {
      term: 'gano cewa na gaya',
      language: 'ha',
      gloss: 'find out that I told',
    },
    {
      term: "magana marar kyau ta jima'i",
      language: 'ha',
      gloss: 'sexual harassment talk',
    },
    {
      term: 'amfani da abokina a hanyar mummuna',
      language: 'ha',
      gloss: 'using my friend in a bad way',
    },
    {
      term: 'agaghị agwa onye ọ bụla',
      language: 'ig',
      gloss: 'not tell anyone',
    },
    {
      term: 'agaghi agwa onye o bula',
      language: 'ig',
      gloss: 'not tell anyone (no diacritics)',
    },
    { term: 'emerụ m ahụ', language: 'ig', gloss: 'hurting me' },
    { term: 'emeru m ahu', language: 'ig', gloss: 'hurting me (no diacritics)' },
    {
      term: 'emerụ nwanne m nta',
      language: 'ig',
      gloss: 'hurting my younger sibling',
    },
    {
      term: 'emeru nwanne m nta',
      language: 'ig',
      gloss: 'hurting my younger sibling (no diacritics)',
    },
    {
      term: 'ahapụ m obi maka ụbọchị ole na ole',
      language: 'ig',
      gloss: 'leaves me alone for several days',
    },
    {
      term: 'ahapu m obi maka ubochi ole na ole',
      language: 'ig',
      gloss: 'leaves me alone for several days (no diacritics)',
    },
    {
      term: 'zipụrụ ya foto nzuzo',
      language: 'ig',
      gloss: 'send him private pictures',
    },
    {
      term: 'zipuru ya foto nzuzo',
      language: 'ig',
      gloss: 'send him private pictures (no diacritics)',
    },
    { term: 'nzukọ nzuzo anyị', language: 'ig', gloss: 'our secret meetings' },
    {
      term: 'nzuko nzuzo anyi',
      language: 'ig',
      gloss: 'our secret meetings (no diacritics)',
    },
    {
      term: 'ihe ọjọọ metụtara mmekọahụ',
      language: 'ig',
      gloss: 'bad things of a sexual nature',
    },
    {
      term: 'ihe ojoo metutara mmekoahu',
      language: 'ig',
      gloss: 'bad things of a sexual nature (no diacritics)',
    },
    {
      term: 'amata na m gwara',
      language: 'ig',
      gloss: 'find out that I told',
    },
    {
      term: 'eji enyi m eme ihe ọjọọ',
      language: 'ig',
      gloss: 'using my friend for bad things',
    },
    {
      term: 'eji enyi m eme ihe ojoo',
      language: 'ig',
      gloss: 'using my friend for bad things (no diacritics)',
    },
  ],
  THREAT_OR_COERCION: [
    {
      term: 'ń gbà mí lọ́kàn',
      language: 'yo',
      gloss: 'threatening me',
    },
    {
      term: 'n gba mi lokan',
      language: 'yo',
      gloss: 'threatening me (no diacritics)',
    },
    {
      term: 'gba mi lokan',
      language: 'yo',
      gloss: 'threatened me (no progressive marker)',
    },
    { term: 'na eyi m egwu', language: 'ig', gloss: 'threatening me' },
    {
      term: 'na-eyi m egwu',
      language: 'ig',
      gloss: 'threatening me (hyphenated)',
    },
    {
      term: 'yi min farmaki',
      language: 'ha',
      gloss: 'attacked me',
    },
    {
      term: 'kò ní ààbò láti lọ sí ilé',
      language: 'yo',
      gloss: 'not safe to go home',
    },
    {
      term: 'ko ni aabo lati lo si ile',
      language: 'yo',
      gloss: 'not safe to go home (no diacritics)',
    },
    {
      term: 'fi agbára rọ mí lọ́wọ́',
      language: 'yo',
      gloss: 'forcing me',
    },
    {
      term: 'fi agbara ro mi lowo',
      language: 'yo',
      gloss: 'forcing me (no diacritics)',
    },
    { term: 'kọlu mí', language: 'yo', gloss: 'attacked me' },
    { term: 'kolu mi', language: 'yo', gloss: 'attacked me (no diacritics)' },
    {
      term: 'yana min barazana',
      language: 'ha',
      gloss: 'threatening me (ongoing)',
    },
    {
      term: 'ya yi min barazana',
      language: 'ha',
      gloss: 'threatened me',
    },
    {
      term: 'ba na da tsaro in je gida',
      language: 'ha',
      gloss: 'no safety going home',
    },
    {
      term: 'barazana ta yanar gizo',
      language: 'ha',
      gloss: 'threats via the internet',
    },
    {
      term: 'tsumame ni in hadu',
      language: 'ha',
      gloss: 'forcing me to meet',
    },
    {
      term: 'enweghị m nchebe ịga n\'ụlọ',
      language: 'ig',
      gloss: 'no safety going home',
    },
    {
      term: 'enweghi m nchebe iga n ulo',
      language: 'ig',
      gloss: 'no safety going home (no diacritics)',
    },
    { term: 'wakporo m', language: 'ig', gloss: 'attacked me' },
    {
      term: 'akwa ike ka m zụkọrọ',
      language: 'ig',
      gloss: 'forcing me to meet',
    },
    {
      term: 'akwa ike ka m zukoro',
      language: 'ig',
      gloss: 'forcing me to meet (no diacritics)',
    },
  ],
};

// The intent engine lowercases userContent before substring matching, so an
// uppercase term here would be silently dead — fail loud at module load.
for (const [intentId, entries] of Object.entries(VERNACULAR_KEYWORDS)) {
  for (const entry of entries) {
    if (entry.term !== entry.term.toLowerCase()) {
      throw new Error(
        `Vernacular keyword must be lowercase: ${intentId} → "${entry.term}"`,
      );
    }
  }
}

/** Terms merged into the given intent's server keyword list. */
export function vernacularKeywordsFor(intentId: string): string[] {
  return (VERNACULAR_KEYWORDS[intentId] ?? []).map((entry) => entry.term);
}
