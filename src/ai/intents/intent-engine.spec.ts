import { Test, TestingModule } from '@nestjs/testing';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import { IntentEngineService } from './intent-engine.service.js';

function aiResult(overrides: Partial<AiGenerationResult> = {}): AiGenerationResult {
  return {
    message: 'ok',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
    ...overrides,
  };
}

describe('IntentEngineService', () => {
  let engine: IntentEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentEngineService],
    }).compile();
    engine = module.get(IntentEngineService);
  });

  it('returns no verdict for ordinary supportive chat', () => {
    expect(
      engine.evaluate({
        userContent: 'Classes went okay today, thanks for asking.',
        aiResult: aiResult(),
      }),
    ).toBeNull();
  });

  it('server keywords escalate even when the model says candidate=false', () => {
    const verdict = engine.evaluate({
      userContent: 'I have been thinking about suicide lately.',
      aiResult: aiResult(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.intentId).toBe('SUICIDAL_IDEATION');
    expect(verdict!.matchedBy).toBe('SERVER_KEYWORDS');
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
    expect(verdict!.keywordEvidence).toContain('suicide');
  });

  it('the model can never downgrade a server keyword match', () => {
    const verdict = engine.evaluate({
      userContent: 'no reason to live honestly',
      aiResult: aiResult({
        supportFlag: {
          candidate: true,
          category: 'LOW_MOOD',
          severity: 'TIER_1_MODERATE',
        },
      }),
    });
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
  });

  it('AI categories confirm a rule-bound intent at max(intent, model) severity', () => {
    const verdict = engine.evaluate({
      userContent: 'everything feels unmanageable right now',
      aiResult: aiResult({
        supportFlag: {
          candidate: true,
          category: 'SUICIDAL_IDEATION',
          severity: 'TIER_2_HIGH',
        },
      }),
    });
    expect(verdict!.matchedBy).toBe('AI_CATEGORY');
    expect(verdict!.intentId).toBe('SUICIDAL_IDEATION');
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
  });

  it('uncategorised model candidates keep a triage verdict without intent actions', () => {
    const verdict = engine.evaluate({
      userContent: 'my hall mates and I argue every night about noise',
      aiResult: aiResult({
        supportFlag: { candidate: true, category: 'SOCIAL_PRESSURE', severity: 'TIER_1_MODERATE' },
      }),
    });
    expect(verdict!.matchedBy).toBe('MODEL_CANDIDATE');
    expect(verdict!.intentId).toBeNull();
    expect(verdict!.category).toBe('SOCIAL_PRESSURE');
    expect(verdict!.actions).toEqual([{ type: 'SUPPORT_FLAG' }]);
  });

  it('highest severity wins when several intents match keywords', () => {
    const verdict = engine.evaluate({
      userContent: 'I panicked and cut myself a little while ago',
      aiResult: aiResult({
        supportFlag: { candidate: true, category: 'SELF_HARM', severity: 'TIER_3_ACUTE' },
      }),
    });
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
    expect(['SELF_HARM', 'ACUTE_PANIC']).toContain(verdict!.intentId);
  });

  it("'NONE' category from the model is treated as no category", () => {
    const verdict = engine.evaluate({
      userContent: 'weird dreams last night but I am fine',
      aiResult: aiResult({
        supportFlag: { candidate: true, category: 'NONE', severity: 'TIER_1_MODERATE' },
      }),
    });
    expect(verdict!.matchedBy).toBe('MODEL_CANDIDATE');
    expect(verdict!.category).toBe('NONE');
  });

  it('vernacular keyword packs escalate Hausa suicidal language', () => {
    const verdict = engine.evaluate({
      userContent: 'Ina son in mutu',
      aiResult: aiResult(),
    });
    expect(verdict).not.toBeNull();
    expect(verdict!.intentId).toBe('SUICIDAL_IDEATION');
    expect(verdict!.matchedBy).toBe('SERVER_KEYWORDS');
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
    expect(verdict!.keywordEvidence).toContain('ina son in mutu');
  });

  it('vernacular Pidgin panic terms map to ACUTE_PANIC', () => {
    const verdict = engine.evaluate({
      userContent: 'i no fit breathe',
      aiResult: aiResult(),
    });
    expect(verdict!.intentId).toBe('ACUTE_PANIC');
    expect(verdict!.severity).toBe('TIER_2_HIGH');
    expect(verdict!.keywordEvidence).toContain('i no fit breathe');
  });

  it('vernacular matching is case-insensitive like the English packs', () => {
    const verdict = engine.evaluate({
      userContent: 'I WAN DIE',
      aiResult: aiResult(),
    });
    expect(verdict!.intentId).toBe('SUICIDAL_IDEATION');
    expect(verdict!.keywordEvidence).toContain('i wan die');
  });

  it('benign vernacular chat does not trip the packs', () => {
    expect(
      engine.evaluate({
        userContent: 'Mo ti rẹ̀ rẹ̀ lónìí',
        aiResult: aiResult(),
      }),
    ).toBeNull();
  });
});
