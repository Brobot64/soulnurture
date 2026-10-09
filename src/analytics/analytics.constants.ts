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
