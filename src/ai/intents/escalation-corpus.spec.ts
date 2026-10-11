import { Test, TestingModule } from '@nestjs/testing';
import { SupportFlagSeverity } from '@prisma/client';
import { IntentEngineService } from './intent-engine.service.js';
import {
  ESCALATION_CORPUS,
  type EscalationCorpusRow,
} from './escalation-corpus.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';

/**
 * The false-positive / false-negative guard from the Week-3 coordination
 * report (High risk, due week 5), now encoding the full development &
 * safety-evaluation dataset: 60 SN rows (20 A / 20 B / 20 C) plus 11 legacy
 * adversarial phrasing rows. Every row must resolve exactly as specified on
 * every run — this is the executable surrogate for the BA-held escalation
 * rules dataset until clinical sign-off replaces/tunes it.
 *
 * Each row runs through two simulated model behaviours:
 *   silentModel — the model proposes nothing; whatever fires is the server
 *     keyword floor. C rows MUST escalate here (TIER_3_ACUTE); A and most B
 *     rows must stay silent (the floor never over-escalates); a few B rows
 *     legitimately floor-fire at TIER_2 (panic / low-mood phrasing).
 *   rowModel — the model proposes candidate=true with the category a correct
 *     model would emit (row.modelCategory). A rows may only ever produce a
 *     MODEL_CANDIDATE at TIER_2 or below; B rows must surface a review
 *     pathway (rule-bound AI category with HUMAN_SUPPORT_PROMPT, or a TIER_2
 *     triage candidate), never TIER_3.
 */
describe('Escalation corpus (dataset + rules guard)', () => {
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

  function silentModel(): AiGenerationResult {
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

  function rowModel(row: EscalationCorpusRow): AiGenerationResult {
    const base = silentModel();
    return {
      ...base,
      supportFlag: {
        candidate: true,
        category: row.modelCategory ?? null,
        severity: null,
      },
    };
  }

  const floorVerdict = (row: EscalationCorpusRow) =>
    engine.evaluate({ userContent: row.content, aiResult: silentModel() });

  const modelVerdict = (row: EscalationCorpusRow) =>
    engine.evaluate({ userContent: row.content, aiResult: rowModel(row) });

  for (const row of ESCALATION_CORPUS) {
    describe(`${row.exampleId} (${row.supportLevel} / ${row.expectEscalation})`, () => {
      if (row.expectEscalation === 'No') {
        it('server floor stays silent when the model is silent', () => {
          expect(floorVerdict(row)).toBeNull();
        });

        it('even a flagging model may only produce a TIER_2-or-below triage candidate', () => {
          const v = modelVerdict(row);
          if (v === null) return;
          expect(v.intentId).toBeNull();
          expect(v.matchedBy).toBe('MODEL_CANDIDATE');
          expect(SEVERITY_RANK[v.severity]).toBeLessThanOrEqual(
            SEVERITY_RANK.TIER_2_HIGH,
          );
        });
        return;
      }

      if (row.expectEscalation === 'Immediate') {
        it('server floor escalates at TIER_3_ACUTE with the model silent', () => {
          const v = floorVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('SERVER_KEYWORDS');
          expect(v!.intentId).toBe(row.expectIntentId);
          expect(v!.severity).toBe(SupportFlagSeverity.TIER_3_ACUTE);
          expect(v!.keywordEvidence.length).toBeGreaterThan(0);
        });

        it('model agreement never downgrades the floor', () => {
          const v = modelVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('SERVER_KEYWORDS');
          expect(v!.severity).toBe(SupportFlagSeverity.TIER_3_ACUTE);
        });
        return;
      }

      // expectEscalation === 'Review'
      if (row.expectMatchedBy === 'SERVER_KEYWORDS') {
        it('floor may fire, but only at TIER_2 or below', () => {
          const v = floorVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('SERVER_KEYWORDS');
          expect(SEVERITY_RANK[v!.severity]).toBeLessThanOrEqual(
            SEVERITY_RANK.TIER_2_HIGH,
          );
        });

        it('floor beats the model category and still caps at TIER_2', () => {
          const v = modelVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('SERVER_KEYWORDS');
          expect(SEVERITY_RANK[v!.severity]).toBeLessThanOrEqual(
            SEVERITY_RANK.TIER_2_HIGH,
          );
        });
        return;
      }

      if (row.expectMatchedBy === 'AI_CATEGORY') {
        it('floor stays silent; the review rides on the model category', () => {
          expect(floorVerdict(row)).toBeNull();
        });

        it(`model proposes ${row.modelCategory} → rule-bound review with human support`, () => {
          const v = modelVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('AI_CATEGORY');
          expect(v!.intentId).not.toBeNull();
          expect(SEVERITY_RANK[v!.severity]).toBeLessThanOrEqual(
            SEVERITY_RANK.TIER_2_HIGH,
          );
          expect(
            v!.actions.some((a) => a.type === 'HUMAN_SUPPORT_PROMPT'),
          ).toBe(true);
        });
        return;
      }

      // MODEL_CANDIDATE rows: floor silent, model persists a TIER_2 triage flag.
      it('floor stays silent; the model flag persists for professional triage', () => {
        expect(floorVerdict(row)).toBeNull();
      });

      it('model candidate surfaces at TIER_2 or below, never acute', () => {
        const v = modelVerdict(row);
        expect(v).not.toBeNull();
        expect(v!.matchedBy).toBe('MODEL_CANDIDATE');
        expect(v!.intentId).toBeNull();
        expect(SEVERITY_RANK[v!.severity]).toBeLessThanOrEqual(
          SEVERITY_RANK.TIER_2_HIGH,
        );
      });
    });
  }

  describe('dataset integrity', () => {
    it('carries exactly the 60 SN dataset rows', () => {
      const sn = ESCALATION_CORPUS.filter((r) => r.exampleId.startsWith('SN-'));
      expect(sn).toHaveLength(60);
      for (let i = 1; i <= 60; i += 1) {
        const id = `SN-${String(i).padStart(3, '0')}`;
        expect(sn.some((r) => r.exampleId === id)).toBe(true);
      }
    });

    it('splits the dataset 20 / 20 / 20 across support levels A / B / C', () => {
      const sn = ESCALATION_CORPUS.filter((r) => r.exampleId.startsWith('SN-'));
      const count = (level: 'A' | 'B' | 'C') =>
        sn.filter((r) => r.supportLevel === level).length;
      expect(count('A')).toBe(20);
      expect(count('B')).toBe(20);
      expect(count('C')).toBe(20);
    });

    it('keeps every row id unique', () => {
      const ids = ESCALATION_CORPUS.map((r) => r.exampleId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('escalation expectation always matches the support level', () => {
      for (const row of ESCALATION_CORPUS) {
        const expected =
          row.supportLevel === 'A'
            ? 'No'
            : row.supportLevel === 'B'
              ? 'Review'
              : 'Immediate';
        expect(row.expectEscalation, row.exampleId).toBe(expected);
      }
    });

    it('every Immediate row names the intent the floor must fire', () => {
      for (const row of ESCALATION_CORPUS) {
        if (row.expectEscalation === 'Immediate') {
          expect(row.expectIntentId, row.exampleId).not.toBeNull();
        }
      }
    });
  });
});
