import type { IntentVerdict } from './intent-engine.service.js';
import {
  applyIntentVerdict,
} from './intent-executors.js';
import type { IntentApplyContext } from './intent-executors.js';

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
});
