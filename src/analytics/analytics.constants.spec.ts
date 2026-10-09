import { FeelingLabel } from '@prisma/client';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_KINDS,
  activityKindOf,
  ANALYTICS_WINDOWS,
  FEELING_TO_MOOD,
  MOOD_IDS,
  normalizeWindowDays,
} from './analytics.constants.js';

describe('analytics constants', () => {
  it('normalizes window days to the supported set', () => {
    expect(normalizeWindowDays(undefined)).toBe(14);
    expect(normalizeWindowDays('14')).toBe(14);
    expect(normalizeWindowDays('30')).toBe(30);
    expect(normalizeWindowDays('90')).toBe(90);
    expect(normalizeWindowDays('45')).toBe(14);
    expect(normalizeWindowDays('junk')).toBe(14);
  });

  it('pins the supported dashboard windows', () => {
    expect([...ANALYTICS_WINDOWS]).toEqual([14, 30, 90]);
  });

  it('maps every FeelingLabel onto one of the eight mood faces', () => {
    for (const feeling of Object.values(FeelingLabel)) {
      const mood = FEELING_TO_MOOD[feeling];
      expect(mood).toBeDefined();
      expect(MOOD_IDS).toContain(mood);
    }
  });

  it('classifies every feed action under exactly one kind', () => {
    const union = [
      ...ACTIVITY_KINDS.schools,
      ...ACTIVITY_KINDS.people,
      ...ACTIVITY_KINDS.chat,
    ];
    expect(new Set(union).size).toBe(union.length);
    expect([...ACTIVITY_ACTIONS].sort()).toEqual([...union].sort());
    for (const action of union) {
      expect(activityKindOf(action)).not.toBeNull();
    }
  });

  it('classifies representative actions and ignores unmapped ones', () => {
    expect(activityKindOf('school.created')).toBe('schools');
    expect(activityKindOf('school.settings_updated')).toBe('schools');
    expect(activityKindOf('school.user_password_reset')).toBe('people');
    expect(activityKindOf('staff.bootstrap_enrollment')).toBe('people');
    expect(activityKindOf('chat.thread_claimed')).toBe('chat');
    expect(activityKindOf('auth.login')).toBeNull();
  });
});
