import { Test, TestingModule } from '@nestjs/testing';
import { IntentEngineService } from './intent-engine.service.js';
import { ESCALATION_CORPUS } from './escalation-corpus.js';

/**
 * The false-positive / false-negative guard from the Week-3 coordination
 * report (High risk, due week 5). Every corpus row must resolve exactly as
 * specified — this is the executable surrogate for the BA-held escalation
 * rules dataset until clinical sign-off replaces/tunes it.
 */
describe('Escalation corpus (rules dataset guard)', () => {
  let engine: IntentEngineService;

  const SEVERITY_RANK = {
    TIER_1_MODERATE: 1,
    TIER_2_HIGH: 2,
    TIER_3_ACUTE: 3,
  } as const;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IntentEngineService],
    }).compile();
    engine = module.get(IntentEngineService);
  });

  for (const row of ESCALATION_CORPUS) {
    function assistantCandidate() {
      return {
        message: 'ok',
        emotion: { detected: null, confidence: null },
        reflection: { question: null, insight: null },
        resource: { recommended: false, resourceId: null },
        humanSupport: { recommended: false, type: null, reason: null },
        // The corpus always runs against a model that is *already* proposing
        // a flag: the danger case is the server layer mislabeling severity,
        // not the model staying silent.
        supportFlag: { candidate: true, category: null, severity: null },
        action: 'REFLECTION' as const,
      };
    }

    const verdict = () =>
      engine.evaluate({ userContent: row.content, aiResult: assistantCandidate() });

    it(`resolves "${row.content.slice(0, 52)}" as ${row.expectIntentId ?? 'no intent'}`, () => {
      const v = verdict();
      if (row.expectIntentId === null) {
        if (v !== null) {
          expect(v.intentId).toBeNull();
          expect(v.matchedBy).toBe('MODEL_CANDIDATE');
        }
        return;
      }
      expect(v).not.toBeNull();
      expect(v!.intentId).toBe(row.expectIntentId);
      expect(v!.matchedBy).toBe(row.expectMatchedBy);
      if (row.minSeverity) {
        expect(SEVERITY_RANK[v!.severity]).toBeGreaterThanOrEqual(
          SEVERITY_RANK[row.minSeverity],
        );
      }
    });
  }
});
