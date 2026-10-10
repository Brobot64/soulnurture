import { FeelingLabel } from '@prisma/client';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_KINDS,
  activityKindOf,
  ANALYTICS_WINDOWS,
  FEELING_TO_MOOD,
  MOOD_IDS,
  normalizeWindowDays,
  PILOT_DEFAULT_WINDOW_DAYS,
  PILOT_MAX_WINDOW_DAYS,
  PILOT_THEME_LABELS,
  PILOT_THEMES,
  resolvePilotWindow,
  topicTheme,
  triggerTheme,
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

  describe('resolvePilotWindow', () => {
    it('defaults to the last 30 days ending today (UTC)', () => {
      const window = resolvePilotWindow({});
      const today = new Date();
      const expectedTo = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
        ),
      );
      expect(window.days).toBe(PILOT_DEFAULT_WINDOW_DAYS);
      expect(window.to.getTime()).toBe(expectedTo.getTime());
      expect(window.from.getTime()).toBe(
        expectedTo.getTime() - 29 * 24 * 60 * 60 * 1000,
      );
    });

    it('resolves a custom from/to window inclusively', () => {
      const window = resolvePilotWindow({
        from: '2026-01-01',
        to: '2026-01-10',
      });
      expect(window.days).toBe(10);
      expect(window.from.toISOString().slice(0, 10)).toBe('2026-01-01');
      expect(window.to.toISOString().slice(0, 10)).toBe('2026-01-10');
    });

    it('treats a single-day from/to as one day', () => {
      expect(
        resolvePilotWindow({ from: '2026-05-05', to: '2026-05-05' }).days,
      ).toBe(1);
    });

    it('clamps preset days into 1..366 and defaults junk', () => {
      expect(resolvePilotWindow({ days: '7' }).days).toBe(7);
      expect(resolvePilotWindow({ days: '3650' }).days).toBe(
        PILOT_MAX_WINDOW_DAYS,
      );
      expect(resolvePilotWindow({ days: '0' }).days).toBe(1);
      expect(resolvePilotWindow({ days: '-3' }).days).toBe(1);
      expect(resolvePilotWindow({ days: 'junk' }).days).toBe(
        PILOT_DEFAULT_WINDOW_DAYS,
      );
      expect(resolvePilotWindow({ days: '' }).days).toBe(
        PILOT_DEFAULT_WINDOW_DAYS,
      );
    });

    it('rejects malformed or out-of-range windows', () => {
      expect(() => resolvePilotWindow({ from: '2026-01-01' })).toThrow(
        'from and to must be provided together',
      );
      expect(() => resolvePilotWindow({ to: '2026-01-01' })).toThrow(
        'from and to must be provided together',
      );
      expect(() =>
        resolvePilotWindow({ from: '2026-01-31', to: '2026-01-01' }),
      ).toThrow('from must not be after to');
      expect(() =>
        resolvePilotWindow({ from: '2026-02-31', to: '2026-03-01' }),
      ).toThrow('from and to must be valid YYYY-MM-DD dates');
      expect(() =>
        resolvePilotWindow({ from: '01-01-2026', to: '2026-01-10' }),
      ).toThrow('from and to must be valid YYYY-MM-DD dates');
      expect(() =>
        resolvePilotWindow({ from: '2025-01-01', to: '2026-06-01' }),
      ).toThrow(`window cannot exceed ${PILOT_MAX_WINDOW_DAYS} days`);
    });
  });

  describe('pilot themes', () => {
    it('covers every theme with a dashboard label', () => {
      expect(PILOT_THEMES).toHaveLength(8);
      for (const theme of PILOT_THEMES) {
        expect(PILOT_THEME_LABELS[theme]).toBeTruthy();
      }
    });

    it('folds check-in triggers case-insensitively onto themes', () => {
      expect(triggerTheme('School')).toBe('academic_pressure');
      expect(triggerTheme('  FEELING ALONE  ')).toBe('loneliness');
      expect(triggerTheme('friends')).toBe('social_peer');
      expect(triggerTheme('something else')).toBe('other');
      expect(triggerTheme('mystery')).toBe('other');
    });

    it('folds session topics onto themes and defaults unknown to other', () => {
      expect(topicTheme('Exam')).toBe('academic_pressure');
      expect(topicTheme('bullying')).toBe('social_peer');
      expect(topicTheme('identity')).toBe('self_confidence');
      expect(topicTheme('money')).toBe('other');
      expect(topicTheme('not-a-topic')).toBe('other');
    });
  });
});
