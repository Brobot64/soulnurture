import { Test, TestingModule } from '@nestjs/testing';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import { IntentEngineService } from './intent-engine.service.js';

function aiResult(): AiGenerationResult {
  return {
    message: 'ok',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
  };
}

describe('safety keyword matching (item 7)', () => {
  let engine: IntentEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentEngineService],
    }).compile();
    engine = module.get(IntentEngineService);
  });

  const verdictFor = (userContent: string) =>
    engine.evaluate({ userContent, aiResult: aiResult() });

  it('matches whole words only — "deadline" does not trip "wish i was dead"', () => {
    expect(verdictFor('I wish i was deadline focused today')).toBeNull();
  });

  it('still matches the phrase when it is a whole-word match', () => {
    expect(verdictFor('Honestly I wish I was dead')!.intentId).toBe(
      'SUICIDAL_IDEATION',
    );
  });

  it('treats a curly apostrophe as a straight one', () => {
    expect(verdictFor('I don’t want to be alive anymore')!.intentId).toBe(
      'SUICIDAL_IDEATION',
    );
  });

  it('matches Hausa "will kill myself" (zan kashe kaina)', () => {
    expect(verdictFor('Zan kashe kaina idan haka ta ci gaba')!.intentId).toBe(
      'SUICIDAL_IDEATION',
    );
  });

  // "pa ara mi" is already a SELF_HARM phrase, so these match the acute tier
  // through either intent; the test pins the tier and the no-diacritics match.
  it('matches the Yoruba "I want to kill myself" without diacritics at acute tier', () => {
    const verdict = verdictFor('Mo fe pa ara mi');
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
    expect(['SUICIDAL_IDEATION', 'SELF_HARM']).toContain(verdict!.intentId);
  });

  it('matches the Yoruba phrase with its diacritics at acute tier', () => {
    const verdict = verdictFor('Mo fẹ́ pa ara mi');
    expect(verdict!.severity).toBe('TIER_3_ACUTE');
    expect(['SUICIDAL_IDEATION', 'SELF_HARM']).toContain(verdict!.intentId);
  });

  it('matches Pidgin "I wan kill myself"', () => {
    expect(verdictFor('I wan kill myself, I no fit take this again')!.intentId).toBe(
      'SUICIDAL_IDEATION',
    );
  });
});
