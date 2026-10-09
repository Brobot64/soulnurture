import { SupportFlagSeverity } from '@prisma/client';
import {
  vernacularKeywordsFor,
  type VernacularLanguageCode,
} from './vernacular-keywords.js';

/**
 * ---------------------------------------------------------------------------
 * INTENTS — the configurable safeguarding rules.
 *
 * This file is the "high-escalation rules" surface the clinical reviewer
 * signs off. It is deliberately a plain, declarative list:
 *
 *   intent  = a risk pattern we care about (suicidal ideation, self-harm, …)
 *   signal  = how we detect it (server keywords always checked;
 *             optional AI category confirms when the model proposes one)
 *   actions = what the system does, in order, when the intent matches
 *
 * HOW TO ADD AN INTENT: copy one entry, give it an id/label/description,
 * keywords, and choose actions. No other code changes are required — the
 * engine and executors are generic.
 *
 * Priority rules enforced by the engine (see intent-engine.service.ts):
 *   1. A server keyword match can never be downgraded by the model.
 *   2. When several intents match, the highest severity wins.
 *   3. Model-only candidates persist as AI_CANDIDATE flags (source of truth:
 *      the triage dashboard), unless persistModelCandidates is disabled.
 *
 * Server keywords include the vernacular starter packs (Yoruba/Hausa/Igbo/
 * Nigerian Pidgin) from vernacular-keywords.ts — PENDING_CLINICAL_REVIEW.
 * TIER_3 SAFETY_MESSAGE actions carry native-language drafts too
 * (`messages`, VERNACULAR_SAFETY_017) — PENDING_NATIVE_REVIEW; the executor
 * picks the copy for the turn's reply language and falls back to the
 * approved English wording when a language is missing.
 *
 * The flag rows produced by SUPPORT_FLAG carry `description + reason` so
 * professionals see why each student was referred (report requirement:
 * "view AI safeguarding indicators ... flag plus reason").
 * ---------------------------------------------------------------------------
 */

export type IntentActionType =
  | 'SUPPORT_FLAG'
  | 'HUMAN_SUPPORT_PROMPT'
  | 'SAFETY_MESSAGE'
  | 'GROUNDING'
  | 'RECOMMEND_RESOURCE'
  | 'RECOMMEND_ACTIVITY';

/**
 * Native-language crisis copy, keyed by language code. The SAFETY_MESSAGE
 * executor picks the copy for the turn's reply language; when a language is
 * missing the approved English wording ships instead (never a render — crisis
 * copy is used verbatim). REVIEW STATUS: PENDING_NATIVE_REVIEW — same bar as
 * the vernacular keyword packs; the clinical reviewer must sign off (or
 * amend) every translation before they are treated as approved copy.
 */
export type SafetyMessageCopies = Partial<Record<VernacularLanguageCode, string>>;

export const SAFETY_COPY_REVIEW_STATUS = 'PENDING_NATIVE_REVIEW';

export type IntentAction =
  | { type: 'SUPPORT_FLAG' }
  | { type: 'HUMAN_SUPPORT_PROMPT'; reason: string }
  | { type: 'SAFETY_MESSAGE'; message: string; messages?: SafetyMessageCopies }
  | { type: 'GROUNDING'; exerciseLabel: string }
  | { type: 'RECOMMEND_RESOURCE'; category?: string }
  | { type: 'RECOMMEND_ACTIVITY'; activitySlugs: string[] };

export interface IntentDefinition {
  /** Stable identifier; doubles as the SupportFlag.category written by SUPPORT_FLAG. */
  id: string;
  /** Human-facing name (dashboard trigger label). */
  label: string;
  /** One-line why this intent exists — surfaces in GET /api/v1/ai/config. */
  description: string;
  severity: SupportFlagSeverity;
  serverSignals: {
    /** Lowercase substrings checked against every user message — both sides
     * are diacritic-folded first (see foldDiacritics). */
    keywords: string[];
    /** Canonical AI-suggested categories that confirm this intent. */
    aiCategories: string[];
  };
  /** Executed in listed order. */
  actions: IntentAction[];
}

/**
 * Categories the model may emit for supportFlag.category. Categories that are
 * not bound to an intent below still persist as AI_CANDIDATE flags.
 */
export const CANONICAL_CATEGORIES = [
  'SUICIDAL_IDEATION',
  'SELF_HARM',
  'PANIC',
  'LOW_MOOD',
  'ACADEMIC_STRESS',
  'SOCIAL_PRESSURE',
  'GRIEF',
  'ABUSE',
  'SLEEP_PROBLEM',
  'NONE',
] as const;

/**
 * Severity values the model may emit. The engine coerces anything else
 * (and the server keyword layer overrides the model's choice when stricter).
 */
export const CANONICAL_SEVERITIES = [
  'TIER_1_MODERATE',
  'TIER_2_HIGH',
  'TIER_3_ACUTE',
] as const;

/**
 * Canonical topic vocabulary for session summaries (Phase C step 3). The
 * summary writer must pick from this list only — keeps the memory/search
 * surface uniform and reviewable.
 */
export const CANONICAL_TOPICS = [
  'exam',
  'family',
  'friendship',
  'money',
  'health',
  'sleep',
  'loneliness',
  'bullying',
  'identity',
  'other',
] as const;

export const INTENTS: IntentDefinition[] = [
  {
    id: 'SUICIDAL_IDEATION',
    label: 'Possible suicidal intent',
    description:
      'Language about ending life or believing life is pointless; the most serious wellbeing signal.',
    severity: SupportFlagSeverity.TIER_3_ACUTE,
    serverSignals: {
      keywords: [
        'suicide',
        'suicidal',
        'kill myself',
        'end it all',
        'no reason to live',
        'wish i was dead',
        'want to die',
        'better off dead',
        'not worth living',
        'end my life',
        'take my life',
        // Vernacular packs (yo/ha/ig/pcm) — pending clinical review.
        ...vernacularKeywordsFor('SUICIDAL_IDEATION'),
      ],
      aiCategories: ['SUICIDAL_IDEATION'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      {
        type: 'SAFETY_MESSAGE',
        message:
          "I'm really glad you told me this, and I want you to know you matter. Talking to a person who can truly help you right now is important, so I'm connecting you with someone today.",
        // PENDING_NATIVE_REVIEW — drafts mirroring the approved English copy.
        messages: {
          yo: 'Inú mi dùn gan-an pé o sọ fún mi, mo sì fẹ́ kí o mọ̀ pé o ṣe pàtàkì. Bíbá ẹnìkan tí yóò ràn ọ́ lọ́wọ́ sọ̀rọ̀ báyìí ṣe pàtàkì, nítorí náà mo ń gbé ọ sí ọ̀dọ̀ ẹnìkan lónìí.',
          ha: 'Na gode sosai da ka gaya mini wannan, kuma ina so ka sani cewa kana da muhimmanci. Yana da muhimmanci ka yi magana da wanda zai iya taimaka maka da gaske yanzu, saboda haka ina haɗa ka da wani a yau.',
          ig: 'Obi dị m ụtọ nke ukwuu na ị gwara m nke a, ma m chọrọ ka ị mara na ị dị mkpa. Ọ dị mkpa ka ị gwa onye ga-enyere gị aka n’ezie ugbu a, ya mere m na-ejikọ gị na mmadụ taa.',
          pcm: 'I really happy say you tell me this, and I want you know say you matter well well. E important make you talk to person wey go really help you now, so I dey connect you with somebody today.',
        },
      },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          "When thoughts like this come up, a trained person can help you through. You can reach out to a support person at any time — you don't have to carry this alone.",
      },
      { type: 'RECOMMEND_RESOURCE', category: 'GROUNDING' },
      { type: 'RECOMMEND_ACTIVITY', activitySlugs: ['five-senses-grounding'] },
    ],
  },
  {
    id: 'SELF_HARM',
    label: 'Possible self-harm',
    description:
      'Language about hurting yourself on purpose; treated as acute safeguarding.',
    severity: SupportFlagSeverity.TIER_3_ACUTE,
    serverSignals: {
      keywords: [
        'hurt myself',
        'harm myself',
        'cut myself',
        'cutting myself',
        'burn myself',
        'hit myself',
        'self-harm',
        // Vernacular packs (yo/ha/ig/pcm) — pending clinical review.
        ...vernacularKeywordsFor('SELF_HARM'),
      ],
      aiCategories: ['SELF_HARM'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      {
        type: 'SAFETY_MESSAGE',
        message:
          "Thank you for being honest with me — that takes courage. Because of what you shared, I'm bringing in someone who can support you properly, and you can also reach out to a person at any time.",
        // PENDING_NATIVE_REVIEW — drafts mirroring the approved English copy.
        messages: {
          yo: 'Ó ṣeun fún sísọ òtítọ́ fún mi — ìgboyà ni. Nítorí ohun tí o sọ, mo ń mú ẹnìkan wá tí yóò tọ́jú rẹ dáadáa, o sì lè kan ẹnìkan nígbàkigbà.',
          ha: 'Na gode da ka faɗi gaskiya gare ni — wannan yana buƙatar ƙarfin hali. Saboda abin da ka faɗa, ina kawo wanda zai iya tallafa maka da kyau, kuma za ka iya tuntuɓar wani a kowane lokaci.',
          ig: 'Daalụ maka ịgwa m eziokwu — nke ahụ chọrọ obi ike. N’ihi ihe ị gwara m, m na-akpọta onye ga-enyere gị aka nke ọma, ị pụkwara ịkpọtụrụ mmadụ n’oge ọ bụla.',
          pcm: 'Thank you for tell me true true — e take courage. Because of wetin you share, I dey bring person wey go support you well, and you fit still reach out to person anytime.',
        },
      },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          'Self-harm deserves real human care. A school support person can listen without judgement and help you stay safe.',
      },
      { type: 'RECOMMEND_ACTIVITY', activitySlugs: ['five-senses-grounding'] },
    ],
  },
  {
    id: 'ACUTE_PANIC',
    label: 'Acute panic or overwhelm',
    description:
      'Panic symptoms (breathlessness, racing heart, panic attacks). Grounding first, then human support if it persists.',
    severity: SupportFlagSeverity.TIER_2_HIGH,
    serverSignals: {
      keywords: [
        'panic attack',
        'panicking',
        "can't breathe",
        'cannot breathe',
        'heart racing',
        'shaking and feel like i will collapse',
        // Vernacular packs (yo/ha/ig/pcm) — pending clinical review.
        ...vernacularKeywordsFor('ACUTE_PANIC'),
      ],
      aiCategories: ['PANIC'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      { type: 'GROUNDING', exerciseLabel: '4-7-8 breathing exercise' },
      { type: 'RECOMMEND_ACTIVITY', activitySlugs: ['box-breathing'] },
      { type: 'RECOMMEND_RESOURCE', category: 'GROUNDING' },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          'Panic this strong is worth telling a human about. A support person can sit with you through this and help you steady down.',
      },
    ],
  },
  {
    id: 'PROLONGED_LOW_MOOD',
    label: 'Prolonged low mood',
    description:
      'Persistent hopelessness or feeling stuck in sadness; needs a gentle human hand, not just content.',
    severity: SupportFlagSeverity.TIER_2_HIGH,
    serverSignals: {
      keywords: [
        'no point in anything',
        'nothing helps anymore',
        'everyone is better off without me',
        "i'm just a burden",
        'never good enough',
        // Vernacular packs (yo/ha/ig/pcm) — pending clinical review.
        ...vernacularKeywordsFor('PROLONGED_LOW_MOOD'),
      ],
      aiCategories: ['LOW_MOOD'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          "Feeling this low for a while is heavy. A caring person at your school can listen and walk with you — there's no threshold you need to reach first.",
      },
      { type: 'RECOMMEND_RESOURCE', category: 'EXAM_STRESS' },
      {
        type: 'RECOMMEND_ACTIVITY',
        activitySlugs: ['thought-recap', 'mindful-body-scan'],
      },
    ],
  },
];

/** Human-friendly fallback when only the model (not the rules) flagged. */
export const MODEL_CANDIDATE_LABEL = 'AI safeguarding candidate';
