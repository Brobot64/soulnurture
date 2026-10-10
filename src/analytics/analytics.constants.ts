/// Dashboard analytics windows. Only these `days` values are accepted so the
/// series keys can be cached/forecast by the frontend without surprises.
export const ANALYTICS_WINDOWS = [14, 30, 90] as const;
export type AnalyticsWindowDays = (typeof ANALYTICS_WINDOWS)[number];

export function normalizeWindowDays(raw?: string): AnalyticsWindowDays {
  const value = Number(raw ?? 14);
  return (ANALYTICS_WINDOWS as readonly number[]).includes(value)
    ? (value as AnalyticsWindowDays)
    : 14;
}

/// Mood faces shown on the student journey (frontend MOODS). The backend
/// FeelingLabel enum is finer-grained; this is the many-to-one roll-up the
/// dashboards render. Order is the donut legend order.
export const MOOD_IDS = [
  'GREAT',
  'NORMAL',
  'SAD',
  'ANGRY',
  'CONFUSED',
  'INDIFFERENT',
  'STRANGE',
  'DISTRAUGHT',
] as const;
export type MoodId = (typeof MOOD_IDS)[number];

/// Mirrors frontend `MOODS` feeling mappings (CALM→NORMAL, OVERWHELMED→
/// CONFUSED, TIRED→INDIFFERENT, ANXIOUS→STRANGE, STRESSED→DISTRAUGHT) and
/// folds the remaining enum values into the nearest face so no check-in is
/// ever dropped from the donut.
export const FEELING_TO_MOOD: Record<string, MoodId> = {
  GREAT: 'GREAT',
  HAPPY: 'GREAT',
  HOPEFUL: 'GREAT',
  CALM: 'NORMAL',
  PEACEFUL: 'NORMAL',
  SAD_LOW: 'SAD',
  DOWN: 'SAD',
  ANGRY: 'ANGRY',
  OVERWHELMED: 'CONFUSED',
  TIRED: 'INDIFFERENT',
  ANXIOUS: 'STRANGE',
  STRESSED: 'DISTRAUGHT',
};

export const WEEKDAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/// Activity feed tabs. `kind` is computed per row from the action name; any
/// action outside this map is not surfaced by the feed.
export const ACTIVITY_KINDS = {
  schools: [
    'school.created',
    'school.renamed',
    'school.suspended',
    'school.reactivated',
    'school.settings_updated',
  ],
  people: [
    'school.student_enrolled',
    'school.professional_enrolled',
    'school.admin_enrolled',
    'school.user_updated',
    'school.user_deactivated',
    'school.user_reactivated',
    'school.user_password_reset',
    'staff.bootstrap_enrollment',
  ],
  chat: ['chat.thread_created', 'chat.thread_claimed', 'chat.thread_closed'],
} as const;
export type ActivityKind = keyof typeof ACTIVITY_KINDS;
export const ACTIVITY_ACTIONS: string[] = [
  ...ACTIVITY_KINDS.schools,
  ...ACTIVITY_KINDS.people,
  ...ACTIVITY_KINDS.chat,
];

export function activityKindOf(action: string): ActivityKind | null {
  for (const kind of Object.keys(ACTIVITY_KINDS) as ActivityKind[]) {
    if ((ACTIVITY_KINDS[kind] as readonly string[]).includes(action)) return kind;
  }
  return null;
}

/// ---------------------------------------------------------------------------
/// Pilot analytics (super-admin, aggregate-only). Windows, themes, features.

/// Small-group suppression: any breakdown cell backed by 1–4 distinct
/// students is withheld (null + suppressed flag) so the pilot dashboard can
/// never point back at an individual. 0 stays 0 — no students is not a
/// re-identifiable group.
export const PILOT_SMALL_GROUP_THRESHOLD = 5;

export const PILOT_DEFAULT_WINDOW_DAYS = 30;
export const PILOT_MAX_WINDOW_DAYS = 366;

export interface PilotWindow {
  from: Date;
  to: Date;
  days: number;
}

export interface PilotWindowQuery {
  days?: string;
  from?: string;
  to?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function utcMidnight(dateOnly: string): Date | null {
  if (!DATE_ONLY.test(dateOnly)) return null;
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip: rejects calendar-invalid dates like 2026-02-31.
  if (parsed.toISOString().slice(0, 10) !== dateOnly) return null;
  return parsed;
}

/// Resolves the dashboard window. `from`/`to` (YYYY-MM-DD, inclusive) must
/// be supplied together and define "custom" / "pilot period" ranges; the
/// `days` knob covers the preset windows and defaults to 30 (clamped to
/// 1..PILOT_MAX_WINDOW_DAYS). Throws Error with a caller-safe message —
/// the controller hoists it into a 400.
export function resolvePilotWindow(query: PilotWindowQuery): PilotWindow {
  const hasFrom = query.from !== undefined && query.from !== '';
  const hasTo = query.to !== undefined && query.to !== '';

  if (hasFrom !== hasTo) {
    throw new Error('from and to must be provided together');
  }

  if (hasFrom && hasTo) {
    const from = utcMidnight(query.from as string);
    const to = utcMidnight(query.to as string);
    if (!from || !to) {
      throw new Error('from and to must be valid YYYY-MM-DD dates');
    }
    if (from.getTime() > to.getTime()) {
      throw new Error('from must not be after to');
    }
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > PILOT_MAX_WINDOW_DAYS) {
      throw new Error(`window cannot exceed ${PILOT_MAX_WINDOW_DAYS} days`);
    }
    return { from, to, days };
  }

  const requested = query.days ? Number(query.days) : PILOT_DEFAULT_WINDOW_DAYS;
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), PILOT_MAX_WINDOW_DAYS)
    : PILOT_DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);
  return { from, to, days };
}

/// The eight aggregate wellbeing themes the pilot dashboard reports. These
/// are self-reported themes — never clinical labels.
export const PILOT_THEMES = [
  'academic_pressure',
  'social_peer',
  'family',
  'loneliness',
  'self_confidence',
  'overwhelm',
  'relationships',
  'other',
] as const;
export type PilotTheme = (typeof PILOT_THEMES)[number];

export const PILOT_THEME_LABELS: Record<PilotTheme, string> = {
  academic_pressure: 'Academic pressure',
  social_peer: 'Social & peer',
  family: 'Family',
  loneliness: 'Loneliness',
  self_confidence: 'Self-confidence',
  overwhelm: 'Overwhelm',
  relationships: 'Relationships',
  other: 'Other',
};

/// Check-in trigger labels (frontend journey TRIGGERS set, case-insensitive)
/// folded onto the pilot themes. Anything unmapped is 'other'.
export const PILOT_TRIGGER_TO_THEME: Record<string, PilotTheme> = {
  school: 'academic_pressure',
  friends: 'social_peer',
  relationship: 'relationships',
  family: 'family',
  sleep: 'overwhelm',
  'feeling alone': 'loneliness',
  'something else': 'other',
};

/// Session-summary canonical topics (intents CANONICAL_TOPICS) folded onto
/// the same themes.
export const PILOT_TOPIC_TO_THEME: Record<string, PilotTheme> = {
  exam: 'academic_pressure',
  friendship: 'social_peer',
  bullying: 'social_peer',
  family: 'family',
  loneliness: 'loneliness',
  identity: 'self_confidence',
  sleep: 'overwhelm',
  money: 'other',
  health: 'other',
  other: 'other',
};

function normalizedThemeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function triggerTheme(trigger: string): PilotTheme {
  return PILOT_TRIGGER_TO_THEME[normalizedThemeKey(trigger)] ?? 'other';
}

export function topicTheme(topic: string): PilotTheme {
  return PILOT_TOPIC_TO_THEME[normalizedThemeKey(topic)] ?? 'other';
}

/// Feature-usage rows: every row maps one or more tracked event kinds onto a
/// student-facing feature. `profile` is listed in the spec but has no
/// tracked server event yet — the service reports it as unavailable.
export const PILOT_FEATURES = [
  { id: 'check_in', label: 'Check-ins' },
  { id: 'ai_chat', label: 'AI chat' },
  { id: 'voice', label: 'Voice interactions' },
  { id: 'reflection', label: 'Guided reflection' },
  { id: 'resources', label: 'Resources' },
  { id: 'human_support', label: 'Human support' },
  { id: 'profile', label: 'Profile' },
] as const;
export type PilotFeatureId = (typeof PILOT_FEATURES)[number]['id'];
