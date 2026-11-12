import { Test, TestingModule } from '@nestjs/testing';
import {
  CheckInAnswerState,
  IndicatorLevel,
  SupportFlagSeverity,
} from '@prisma/client';
import { ContentService } from '../../content/content.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IntentEngineService } from './intent-engine.service.js';
import { INTENT_EXECUTOR_REGISTRY } from './intent-executors.js';
import type { IntentApplyContext } from './intent-executors.js';
import { INDICATOR_RULES } from './indicators.config.js';
import type { IntentAction } from './intents.config.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';

/**
 * Doc A §8's two uncertainty rows, plus the invariant that makes them hold.
 *
 * U-01 and U-02 are the rows the escalation corpus cannot carry: level U is not
 * an escalation expectation, it is a refusal to conclude, and a skipped safety
 * question is a check-in field rather than a message. Forcing either into
 * `escalation-corpus.ts` would have produced a test that passes by asserting
 * nothing, so they live here.
 *
 * What is actually under guard is the *direction of the inference*. Doc A's
 * prohibitions are not "never say safe" in the abstract — they are that absence
 * of evidence must never be read as evidence of absence. A nullable `level`
 * column is exactly where that mistake gets made, so every assertion below
 * pins one way the system is forbidden to read a null.
 */

const silentModel = (): AiGenerationResult => ({
  message: 'ok',
  emotion: { detected: null, confidence: null },
  reflection: { question: null, insight: null },
  resource: { recommended: false, resourceId: null },
  humanSupport: { recommended: false, type: null, reason: null },
  supportFlag: { candidate: false, category: null, severity: null },
  action: 'REFLECTION',
});

/** The model flags but has no rule-bound category — the honest "I'm not sure". */
const unsureModel = (): AiGenerationResult => ({
  ...silentModel(),
  supportFlag: { candidate: true, category: null, severity: null },
});

// Genuinely ambiguous or self-contradicting disclosures. None carries a floor
// keyword, and none of them is a "safe" sentence either — that is the level.
const AMBIGUOUS = [
  'Something has been happening at home and I am not sure if I am allowed to say it.',
  'I keep going between being fine and being scared and I cannot say which is true.',
  'It might be nothing. It might be everything. I do not know how to put it.',
];

describe('Doc A §8 U-01 — potentially serious but unclear stays unclear', () => {
  let engine: IntentEngineService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentEngineService],
    }).compile();
    engine = module.get(IntentEngineService);
  });

  it.each(AMBIGUOUS)('does not classify "%s"', (content) => {
    // Silence here is not a downgrade: the row never acquires a level, which
    // the surfaces render as Unclassified rather than as Level A.
    expect(engine.evaluate({ userContent: content, aiResult: silentModel() })).toBeNull();
  });

  it('routes an unsure model flag to a human instead of resolving it', () => {
    const verdict = engine.evaluate({
      userContent: AMBIGUOUS[0],
      aiResult: unsureModel(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.matchedBy).toBe('MODEL_CANDIDATE');
    expect(verdict!.intentId).toBeNull();
    // Uncertainty never borrows the acuteness of the topic it is unsure about.
    expect(verdict!.severity).toBe(SupportFlagSeverity.TIER_2_HIGH);
  });

  it('still escalates the moment the ambiguity resolves into a keyword', () => {
    // The other half of U-01: "conflicting" must not become a licence to wait.
    const verdict = engine.evaluate({
      userContent: "It might be nothing, but I don't want to be alive any more.",
      aiResult: silentModel(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.matchedBy).toBe('SERVER_KEYWORDS');
    expect(verdict!.severity).toBe(SupportFlagSeverity.TIER_3_ACUTE);
  });
});

describe('Doc A §8 U-02 — a skipped safety question is unknown, not safe', () => {
  it('gives an unanswered prompt no state that reads as an all-clear', () => {
    // The vocabulary is the guard. There is no SAFE or NO_RISK member to
    // default into, so a consumer that wants to conclude safety has to do it
    // in its own code, where a reviewer can watch it doing it.
    expect(Object.keys(CheckInAnswerState).sort()).toEqual([
      'ANSWERED',
      'NOT_PRESENTED',
      'PREFER_NOT_TO_SAY',
      'SKIPPED',
    ]);
  });

  it('has no indicator rule that fires on an absent answer', () => {
    // Every rule names a positive evidence source and none is switched on, so a
    // skipped prompt produces no level at all today. This is the assertion that
    // has to be revisited with the psychologist the moment somebody sets
    // `configured: true` — auto-recording on absence of evidence is the exact
    // inference Doc A forbids (D5).
    const evidenceSources = new Set(INDICATOR_RULES.flatMap((r) => r.evidence));
    expect([...evidenceSources].sort()).toEqual([
      'AI_CATEGORY',
      'CHECKIN_SIGNAL',
      'MESSAGE_KEYWORDS',
    ]);
    expect(INDICATOR_RULES.every((r) => r.configured === false)).toBe(true);
  });

  it('keeps the only level-U rule blocked on the prompts review withheld', () => {
    const uRules = INDICATOR_RULES.filter((r) => r.level === IndicatorLevel.U);
    expect(uRules.map((r) => r.id)).toEqual(['IND-U01']);
    expect(uRules[0].blockedOn).toContain('CP-09');
  });
});

describe('the level axis is a mapping, never a gradient', () => {
  let engine: IntentEngineService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentEngineService],
    }).compile();
    engine = module.get(IntentEngineService);
  });

  it('writes the mapping grade and nothing the tier implies', async () => {
    const prisma = {
      supportFlag: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'flag-1' }),
      },
      studentProfile: {
        findUnique: vi.fn().mockResolvedValue({ user: { schoolId: 'school-1' } }),
      },
    };
    const ctx = {
      prisma,
      auditService: { log: vi.fn().mockResolvedValue(undefined) },
      studentId: 'student-1',
      studentRef: 'REF-1',
      classLabel: null,
      conversationId: 'conv-1',
      userContent: AMBIGUOUS[2],
      relevantResources: [],
      result: silentModel(),
    } as unknown as IntentApplyContext;

    const verdict = engine.evaluate({
      userContent: ctx.userContent,
      aiResult: unsureModel(),
    });
    await INTENT_EXECUTOR_REGISTRY.SUPPORT_FLAG.execute(
      { type: 'SUPPORT_FLAG' } as IntentAction,
      verdict!,
      ctx,
      [],
    );

    const data = prisma.supportFlag.create.mock.calls[0][0].data as Record<string, unknown>;
    // The owner's 2026-11-12 rule: the condition table first, then the AI's own
    // tier. This verdict has no condition — the model named a category no rule is
    // bound to — so its level is its tier. Worth reading together with
    // `intent-engine.service.ts` layer 3: the TIER_2 here is the engine's default
    // for an unbound candidate whose model asserted no severity, so the B is our
    // fallback two deep, and `levelSource: 'AI_TIER'` is what tells a reviewer.
    expect(data.level).toBe(IndicatorLevel.B);
    expect(data.severity).toBe(SupportFlagSeverity.TIER_2_HIGH);
    expect(data.reviewDecision).toBeUndefined();
    // And no provenance the rule catalogue does not actually have.
    expect(data.ruleId).toBeUndefined();
  });

  it('has no default level for a row nothing graded', () => {
    // Four members, none of them "none". A null column is the only honest
    // representation of "no approved rule looked at this", which is why
    // support-flags.service.ts counts it as UNCLASSIFIED instead of A.
    expect(Object.keys(IndicatorLevel).sort()).toEqual(['A', 'B', 'C', 'U']);
  });
});

describe('the capture gate U-02 leans on', () => {
  // ContentService's own spec covers the register; this row is here because the
  // withheld safety prompts are what U-02 depends on: a "skipped" answer can
  // never be laundered into a real answer to a question review has withheld.
  it('refuses a BLOCKED safety prompt instead of recording nothing', async () => {
    const prisma = {
      contentItem: {
        findMany: vi.fn().mockResolvedValue([
          { code: 'CP-05', status: 'APPROVED_ACTIVE' },
          { code: 'CP-09', status: 'BLOCKED' },
        ]),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContentService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    await expect(
      module.get(ContentService).assertAskable(['CP-05', 'CP-09']),
    ).rejects.toThrow(/CP-09/);
  });
});
