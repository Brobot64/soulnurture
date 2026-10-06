import { SupportFlagSeverity } from '@prisma/client';

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
  | 'RECOMMEND_RESOURCE';

export type IntentAction =
  | { type: 'SUPPORT_FLAG' }
  | { type: 'HUMAN_SUPPORT_PROMPT'; reason: string }
  | { type: 'SAFETY_MESSAGE'; message: string }
  | { type: 'GROUNDING'; exerciseLabel: string }
  | { type: 'RECOMMEND_RESOURCE'; category?: string };

export interface IntentDefinition {
  /** Stable identifier; doubles as the SupportFlag.category written by SUPPORT_FLAG. */
  id: string;
  /** Human-facing name (dashboard trigger label). */
  label: string;
  /** One-line why this intent exists — surfaces in GET /api/v1/ai/config. */
  description: string;
  severity: SupportFlagSeverity;
  serverSignals: {
    /** Lowercase substrings checked against every user message. */
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
      ],
      aiCategories: ['SUICIDAL_IDEATION'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      {
        type: 'SAFETY_MESSAGE',
        message:
          "I'm really glad you told me this, and I want you to know you matter. Talking to a person who can truly help you right now is important, so I'm connecting you with someone today.",
      },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          "When thoughts like this come up, a trained person can help you through. You can reach out to a support person at any time — you don't have to carry this alone.",
      },
      { type: 'RECOMMEND_RESOURCE', category: 'GROUNDING' },
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
      ],
      aiCategories: ['SELF_HARM'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      {
        type: 'SAFETY_MESSAGE',
        message:
          "Thank you for being honest with me — that takes courage. Because of what you shared, I'm bringing in someone who can support you properly, and you can also reach out to a person at any time.",
      },
      {
        type: 'HUMAN_SUPPORT_PROMPT',
        reason:
          'Self-harm deserves real human care. A school support person can listen without judgement and help you stay safe.',
      },
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
      ],
      aiCategories: ['PANIC'],
    },
    actions: [
      { type: 'SUPPORT_FLAG' },
      { type: 'GROUNDING', exerciseLabel: '4-7-8 breathing exercise' },
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
    ],
  },
];

/** Human-friendly fallback when only the model (not the rules) flagged. */
export const MODEL_CANDIDATE_LABEL = 'AI safeguarding candidate';
