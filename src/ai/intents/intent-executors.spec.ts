import { ACTIVITY_CATALOG_SLUGS } from '../activities/activities.config.js';
import type { IntentVerdict } from './intent-engine.service.js';
import {
  applyIntentVerdict,
} from './intent-executors.js';
import type { IntentApplyContext } from './intent-executors.js';
import { INTENTS } from './intents.config.js';
import type { IntentAction } from './intents.config.js';

const verdict = (overrides: Partial<IntentVerdict> = {}): IntentVerdict => ({
  intentId: 'SUICIDAL_IDEATION',
  intentLabel: 'Possible suicidal intent',
  intentDescription: 'Language about ending life.',
  matchedBy: 'SERVER_KEYWORDS',
  severity: 'TIER_3_ACUTE',
  category: 'SUICIDAL_IDEATION',
  keywordEvidence: ['no reason to live'],
  actions: [{ type: 'SUPPORT_FLAG' }],
  notes: [],
  ...overrides,
});

const context = (
  prisma: Record<string, unknown>,
  auditService: Record<string, unknown>,
  overrides: Partial<IntentApplyContext> = {},
): IntentApplyContext => ({
  prisma: prisma as never,
  auditService: auditService as never,
  result: {
    message: 'model said something',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
  },
  studentId: 'student-1',
  studentRef: 'Jude O.',
  classLabel: 'Sociology 300L',
  conversationId: 'conv-1',
  userContent: 'there is no reason to live here anymore',
  relevantResources: [
    { id: 'res-1', title: 'Breath', type: 'SOMATIC_EXERCISE', category: 'GROUNDING', description: 'Breathing guide' },
  ],
  ...overrides,
});

describe('applyIntentVerdict', () => {
  let prisma: Record<string, ReturnType<typeof vi.fn>>;
  let auditService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    prisma = {
      supportFlag: { findFirst: vi.fn(), create: vi.fn() },
      wellbeingActivity: { findMany: vi.fn() },
    };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  });

  it('persists the SUPPORT_FLAG with intent binding, reason and audit', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    prisma.supportFlag.create.mockResolvedValue({ id: 'flag-1' });

    const notes = await applyIntentVerdict(
      verdict(),
      context(prisma, auditService),
    );

    expect(prisma.supportFlag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          studentId: 'student-1',
          studentRef: 'Jude O.',
          classLabel: 'Sociology 300L',
          triggerLabel: 'Possible suicidal intent',
          category: 'SUICIDAL_IDEATION',
          severity: 'TIER_3_ACUTE',
          intentId: 'SUICIDAL_IDEATION',
          status: 'OPEN',
          source: 'SERVER_POLICY',
        }),
      }),
    );
    const data = prisma.supportFlag.create.mock.calls[0][0].data as {
      aiContextSummary: string;
    };
    expect(data.aiContextSummary).toContain('no reason to live');
    expect(data.aiContextSummary).toContain('Sociology');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_flag.auto_created' }),
    );
    expect(notes.join(' ')).toContain('persisted');
  });

  it('de-dupes an active flag for the same conversation + intent', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue({ id: 'flag-existing' });

    const notes = await applyIntentVerdict(
      verdict(),
      context(prisma, auditService),
    );

    expect(prisma.supportFlag.create).not.toHaveBeenCalled();
    expect(notes.join(' ')).toContain('not duplicated');
  });

  it('safety message replaces the model wording for acute risk', async () => {
    const ctx = context(prisma, auditService);
    await applyIntentVerdict(
      verdict({
        actions: [{ type: 'SAFETY_MESSAGE', message: 'You matter. I am connecting you with someone now.' }],
      }),
      ctx,
    );
    expect(ctx.result.message).toContain('You matter');
  });

  it("picks the reviewed vernacular safety copy for the turn's reply language", async () => {
    const ctx = context(prisma, auditService, { replyLanguage: 'yo' });
    const notes = await applyIntentVerdict(
      verdict({
        actions: [
          {
            type: 'SAFETY_MESSAGE',
            message: 'You matter.',
            messages: { yo: 'O ṣe pàtàkì gan-an.' },
          },
        ],
      }),
      ctx,
    );
    expect(ctx.result.message).toBe('O ṣe pàtàkì gan-an.');
    expect(notes.join(' ')).toContain('reviewed yo copy');
  });

  it('keeps the approved English copy on an English turn even when vernacular copies exist', async () => {
    const ctx = context(prisma, auditService, { replyLanguage: 'en' });
    await applyIntentVerdict(
      verdict({
        actions: [
          {
            type: 'SAFETY_MESSAGE',
            message: 'You matter.',
            messages: { yo: 'O ṣe pàtàkì gan-an.' },
          },
        ],
      }),
      ctx,
    );
    expect(ctx.result.message).toBe('You matter.');
  });

  it('falls back to the English copy and notes the gap when the language has no reviewed copy', async () => {
    const ctx = context(prisma, auditService, { replyLanguage: 'ha' });
    const notes = await applyIntentVerdict(
      verdict({
        actions: [
          {
            type: 'SAFETY_MESSAGE',
            message: 'You matter.',
            messages: { yo: 'O ṣe pàtàkì gan-an.' },
          },
        ],
      }),
      ctx,
    );
    expect(ctx.result.message).toBe('You matter.');
    expect(notes.join(' ')).toContain('No reviewed ha safety copy yet');
  });

  it('human support prompt flips humanSupport and forces the HUMAN_SUPPORT action', async () => {
    const ctx = context(prisma, auditService);
    await applyIntentVerdict(
      verdict({
        actions: [{ type: 'HUMAN_SUPPORT_PROMPT', reason: 'A person can help right now.' }],
      }),
      ctx,
    );
    expect(ctx.result.humanSupport.recommended).toBe(true);
    expect(ctx.result.humanSupport.reason).toContain('right now');
    expect(ctx.result.action).toBe('HUMAN_SUPPORT');
  });

  it('grounding sets action + exercise label', async () => {
    const ctx = context(prisma, auditService);
    await applyIntentVerdict(
      verdict({
        actions: [{ type: 'GROUNDING', exerciseLabel: '4-7-8 breathing exercise' }],
      }),
      ctx,
    );
    expect(ctx.result.action).toBe('GROUNDING');
    expect(ctx.result.exerciseLabel).toBe('4-7-8 breathing exercise');
  });

  it('resource action filters by category and prefers the model intent', async () => {
    const ctx = context(prisma, auditService, {
      relevantResources: [
        { id: 'wrong-cat', title: 'Friendship', type: 'ARTICLE', category: 'FRIENDSHIPS', description: 'x' },
        { id: 'ground-res', title: 'Breath', type: 'SOMATIC_EXERCISE', category: 'GROUNDING', description: 'x' },
      ],
    });
    ctx.result.resource = { recommended: false, resourceId: null };

    await applyIntentVerdict(
      verdict({ actions: [{ type: 'RECOMMEND_RESOURCE', category: 'GROUNDING' }] }),
      ctx,
    );
    expect(ctx.result.resource).toEqual({ recommended: true, resourceId: 'ground-res' });
    expect(ctx.result.action).toBe('RESOURCE');
  });

  it('keeps a HUMAN_SUPPORT action when resource recommendation follows it', async () => {
    const ctx = context(prisma, auditService);
    ctx.result.action = 'HUMAN_SUPPORT';

    await applyIntentVerdict(
      verdict({ actions: [{ type: 'RECOMMEND_RESOURCE', category: 'GROUNDING' }] }),
      ctx,
    );
    expect(ctx.result.action).toBe('HUMAN_SUPPORT');
    expect(ctx.result.resource.recommended).toBe(true);
  });

  it('one failing executor never blocks the others', async () => {
    prisma.supportFlag.findFirst.mockRejectedValue(new Error('DB hiccup'));

    const ctx = context(prisma, auditService);
    await applyIntentVerdict(
      verdict({
        actions: [
          { type: 'SUPPORT_FLAG' },
          { type: 'SAFETY_MESSAGE', message: 'You matter.' },
        ],
      }),
      ctx,
    );
    expect(ctx.result.message).toBe('You matter.');
    expect(ctx.result.action).toBe('REFLECTION'); // unchanged by the failed flag executor
  });

  it('activity action picks the first configured slug that is approved in the live catalogue', async () => {
    prisma.wellbeingActivity.findMany.mockResolvedValue([
      { slug: 'mindful-body-scan', title: 'Mindful Body Scan' },
      { slug: 'thought-recap', title: 'Thought Recap' },
    ]);

    const ctx = context(prisma, auditService);
    const notes = await applyIntentVerdict(
      verdict({
        actions: [
          {
            type: 'RECOMMEND_ACTIVITY',
            activitySlugs: ['thought-recap', 'mindful-body-scan'],
          },
        ],
      }),
      ctx,
    );

    expect(prisma.wellbeingActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          slug: { in: ['thought-recap', 'mindful-body-scan'] },
          active: true,
          approved: true,
        },
      }),
    );
    expect(ctx.result.activity).toEqual({
      recommended: true,
      slug: 'thought-recap',
      title: 'Thought Recap',
    });
    expect(notes.join(' ')).toContain('thought-recap');
  });

  it('falls back to the next configured slug when the first is not approved', async () => {
    prisma.wellbeingActivity.findMany.mockResolvedValue([
      { slug: 'mindful-body-scan', title: 'Mindful Body Scan' },
    ]);

    const ctx = context(prisma, auditService);
    await applyIntentVerdict(
      verdict({
        actions: [
          {
            type: 'RECOMMEND_ACTIVITY',
            activitySlugs: ['thought-recap', 'mindful-body-scan'],
          },
        ],
      }),
      ctx,
    );

    expect(ctx.result.activity?.slug).toBe('mindful-body-scan');
  });

  it('leaves the result untouched and notes when nothing is approved', async () => {
    prisma.wellbeingActivity.findMany.mockResolvedValue([]);

    const ctx = context(prisma, auditService);
    const notes = await applyIntentVerdict(
      verdict({
        actions: [
          { type: 'RECOMMEND_ACTIVITY', activitySlugs: ['box-breathing'] },
        ],
      }),
      ctx,
    );

    expect(ctx.result.activity ?? null).toBeNull();
    expect(notes.join(' ')).toContain('No approved activity');
  });
});

describe('RECOMMEND_ACTIVITY catalogue integrity', () => {
  const activitySlugsByIntent = (intentId: string): string[] =>
    INTENTS.filter((i) => i.id === intentId).flatMap((i) =>
      i.actions
        .filter(
          (a): a is Extract<IntentAction, { type: 'RECOMMEND_ACTIVITY' }> =>
            a.type === 'RECOMMEND_ACTIVITY',
        )
        .flatMap((a) => a.activitySlugs),
    );

  it('every slug referenced by an intent exists in the seeded catalogue', () => {
    const referenced = INTENTS.flatMap((i) =>
      i.actions.flatMap((a) =>
        a.type === 'RECOMMEND_ACTIVITY' ? a.activitySlugs : [],
      ),
    );
    expect(referenced.length).toBeGreaterThan(0);
    const unknown = referenced.filter(
      (slug) => !ACTIVITY_CATALOG_SLUGS.includes(slug),
    );
    expect(unknown).toEqual([]);
  });

  it('acute-risk intents each recommend a grounding activity', () => {
    expect(activitySlugsByIntent('SUICIDAL_IDEATION')).toContain(
      'five-senses-grounding',
    );
    expect(activitySlugsByIntent('SELF_HARM')).toContain(
      'five-senses-grounding',
    );
    expect(activitySlugsByIntent('ACUTE_PANIC')).toContain('box-breathing');
    expect(activitySlugsByIntent('PROLONGED_LOW_MOOD')).toContain(
      'thought-recap',
    );
  });
});

describe('SAFETY_MESSAGE catalogue integrity', () => {
  const safetyMessages = INTENTS.flatMap((i) =>
    i.actions.filter(
      (a): a is Extract<IntentAction, { type: 'SAFETY_MESSAGE' }> =>
        a.type === 'SAFETY_MESSAGE',
    ),
  );

  it('every scripted safety message ships a non-empty vernacular copy for all four languages', () => {
    expect(safetyMessages.length).toBeGreaterThan(0);
    for (const action of safetyMessages) {
      for (const lang of ['yo', 'ha', 'ig', 'pcm'] as const) {
        expect(action.messages?.[lang]?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});
