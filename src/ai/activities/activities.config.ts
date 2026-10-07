import { ResourceCategory } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * ACTIVITY CATALOGUE — the starter set of backend-orchestrated wellbeing
 * activities (Phase C step 6).
 *
 * The backend records and orchestrates; the frontend renders. `steps` is the
 * renderer contract: an ordered list of typed steps
 * (breath-pacing | timer | prompt-list | body-scan) — frontends implement one
 * component per step type and never invent their own flows.
 *
 * This file is the reviewer-readable source of truth. prisma/seed.ts upserts
 * every entry by slug as active + approved; `approved` in the DB remains the
 * live switch (a reviewer can un-approve without a deploy).
 *
 * Intents reference these slugs via RECOMMEND_ACTIVITY (see intents.config.ts);
 * the executor only recommends activities that are active + approved in the DB.
 * ---------------------------------------------------------------------------
 */

export const ACTIVITY_STEP_TYPES = [
  'breath-pacing',
  'timer',
  'prompt-list',
  'body-scan',
] as const;

export type ActivityStepType = (typeof ACTIVITY_STEP_TYPES)[number];

export interface BreathPhase {
  phase: 'inhale' | 'hold' | 'exhale';
  seconds: number;
}

export interface BreathPacingStep {
  type: 'breath-pacing';
  title: string;
  pattern: BreathPhase[];
  cycles: number;
}

export interface TimerStep {
  type: 'timer';
  title: string;
  seconds: number;
}

export interface PromptListStep {
  type: 'prompt-list';
  title: string;
  prompts: { text: string; seconds?: number }[];
}

export interface BodyScanStep {
  type: 'body-scan';
  title: string;
  regions: { region: string; seconds: number }[];
}

export type ActivityStep =
  | BreathPacingStep
  | TimerStep
  | PromptListStep
  | BodyScanStep;

export interface ActivityCatalogEntry {
  slug: string;
  title: string;
  description: string;
  category: ResourceCategory;
  durationSeconds: number;
  tags: string[];
  steps: ActivityStep[];
}

export const ACTIVITY_CATALOG: ActivityCatalogEntry[] = [
  {
    slug: 'box-breathing',
    title: 'Box Breathing (4-4-4-4)',
    description:
      'A steady square breath — in for four, hold, out for four, hold — to slow a racing body down.',
    category: ResourceCategory.GROUNDING,
    durationSeconds: 120,
    tags: ['Panic', 'Grounding', 'SOS Reset'],
    steps: [
      {
        type: 'breath-pacing',
        title: 'Follow the square',
        pattern: [
          { phase: 'inhale', seconds: 4 },
          { phase: 'hold', seconds: 4 },
          { phase: 'exhale', seconds: 4 },
          { phase: 'hold', seconds: 4 },
        ],
        cycles: 6,
      },
    ],
  },
  {
    slug: '478-breathing',
    title: '4-7-8 Calming Breath',
    description:
      'A longer exhale tells your body the danger has passed — the classic wind-down breath.',
    category: ResourceCategory.SLEEP,
    durationSeconds: 120,
    tags: ['Sleep', 'Anxiety', 'Wind Down'],
    steps: [
      {
        type: 'breath-pacing',
        title: 'Slow the exhale',
        pattern: [
          { phase: 'inhale', seconds: 4 },
          { phase: 'hold', seconds: 7 },
          { phase: 'exhale', seconds: 8 },
        ],
        cycles: 5,
      },
    ],
  },
  {
    slug: 'five-senses-grounding',
    title: '5-4-3-2-1 Five-Senses Grounding',
    description:
      'Walk your attention through what you can see, touch, hear, smell and taste — back into the room you are in.',
    category: ResourceCategory.GROUNDING,
    durationSeconds: 180,
    tags: ['Panic', 'Grounding', 'Dissociation'],
    steps: [
      {
        type: 'prompt-list',
        title: 'Come back to the room',
        prompts: [
          { text: 'Name 5 things you can see around you.', seconds: 60 },
          { text: 'Notice 4 things you can touch or feel.', seconds: 45 },
          { text: 'Listen for 3 sounds.', seconds: 35 },
          { text: 'Find 2 things you can smell.', seconds: 25 },
          { text: 'Notice 1 thing you can taste.', seconds: 15 },
        ],
      },
    ],
  },
  {
    slug: 'mindful-body-scan',
    title: 'Mindful Body Scan',
    description:
      'Move slowly from head to feet, noticing each part of your body without trying to change it.',
    category: ResourceCategory.SLEEP,
    durationSeconds: 180,
    tags: ['Low Mood', 'Deep Relaxation', 'Sleep'],
    steps: [
      {
        type: 'body-scan',
        title: 'Head to feet, slowly',
        regions: [
          { region: 'Head and face', seconds: 20 },
          { region: 'Neck and shoulders', seconds: 20 },
          { region: 'Chest', seconds: 20 },
          { region: 'Belly', seconds: 20 },
          { region: 'Arms and hands', seconds: 20 },
          { region: 'Legs', seconds: 20 },
          { region: 'Feet', seconds: 20 },
          { region: 'Whole body', seconds: 30 },
        ],
      },
    ],
  },
  {
    slug: 'thought-recap',
    title: 'Thought Recap',
    description:
      'Look at the thought that keeps looping, on purpose and gently — is it a fact, a fear, or a habit?',
    category: ResourceCategory.GENERAL,
    durationSeconds: 180,
    tags: ['Low Mood', 'Thinking Patterns', 'Reflection'],
    steps: [
      {
        type: 'prompt-list',
        title: 'Name the loop',
        prompts: [
          { text: 'What thought keeps looping in your mind right now?', seconds: 45 },
          { text: 'What happened just before it started?', seconds: 45 },
          { text: 'Is this thought a fact, a fear, or a habit?', seconds: 45 },
          { text: 'What would you say to a friend who had this thought?', seconds: 45 },
        ],
      },
    ],
  },
  {
    slug: 'worry-slot',
    title: 'Worry Slot',
    description:
      'Write the worry down, give it a real time later today — and let it wait there instead of everywhere.',
    category: ResourceCategory.ANXIETY,
    durationSeconds: 180,
    tags: ['Anxiety', 'Worry', 'Planning'],
    steps: [
      {
        type: 'prompt-list',
        title: 'Park it for later',
        prompts: [
          { text: 'Write down the worry you keep carrying today.', seconds: 45 },
          {
            text: 'Choose a 10-minute "worry slot" for later today — a real time you will keep.',
            seconds: 45,
          },
          {
            text: 'Until that slot, when the worry comes back, remind yourself: it has a time.',
            seconds: 30,
          },
        ],
      },
      { type: 'timer', title: 'Close the slot', seconds: 60 },
    ],
  },
];

export const ACTIVITY_CATALOG_SLUGS: readonly string[] =
  ACTIVITY_CATALOG.map((a) => a.slug);
