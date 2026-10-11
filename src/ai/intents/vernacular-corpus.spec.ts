import { Test, TestingModule } from '@nestjs/testing';
import { SupportFlagSeverity } from '@prisma/client';
import { IntentEngineService } from './intent-engine.service.js';
import { ESCALATION_CORPUS } from './escalation-corpus.js';
import {
  VERNACULAR_CORPUS,
  type VernacularCorpusRow,
} from './vernacular-corpus.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';

/**
 * Vernacular twin of the escalation-corpus guard: every translation in
 * vernacular-corpus.ts must resolve EXACTLY like its English source row, so a
 * student typing in Yoruba, Hausa or Igbo gets the same protection as one
 * typing English. The dominant language rule makes this non-negotiable — the
 * reply already follows the message; the floor must too.
 *
 *   A-source rows → vernacular floor stays silent; a flagging model may only
 *                   yield a TIER_2-or-below MODEL_CANDIDATE.
 *   B-source rows → floor silent; the model lane surfaces the review pathway
 *                   (rule-bound AI category with HUMAN_SUPPORT_PROMPT, or a
 *                   TIER_2 triage candidate), never acute.
 *   C-source rows → the vernacular keyword floor MUST fire the source row's
 *                   intent at TIER_3_ACUTE with the model silent.
 *
 * The translations themselves are PENDING_NATIVE_REVIEW; until a native
 * speaker signs off, these tests guard against regressions in the vernacular
 * keyword packs, not clinical correctness of the wording.
 */
describe('Vernacular corpus (dataset translations guard)', () => {
  let engine: IntentEngineService;

  const SEVERITY_RANK = {
    TIER_1_MODERATE: 1,
    TIER_2_HIGH: 2,
    TIER_3_ACUTE: 3,
  } as const;

  const sourceById = new Map(ESCALATION_CORPUS.map((r) => [r.exampleId, r]));

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

  const floorVerdict = (row: VernacularCorpusRow) =>
    engine.evaluate({ userContent: row.content, aiResult: silentModel() });

  const modelVerdict = (row: VernacularCorpusRow) => {
    const base = silentModel();
    const source = sourceById.get(row.exampleId)!;
    return engine.evaluate({
      userContent: row.content,
      aiResult: {
        ...base,
        supportFlag: {
          candidate: true,
          category: source.modelCategory ?? null,
          severity: null,
        },
      },
    });
  };

  for (const row of VERNACULAR_CORPUS) {
    const source = sourceById.get(row.exampleId);

    describe(`${row.exampleId} [${row.language}]`, () => {
      it('is bound to an existing English source row', () => {
        expect(source, `no source row ${row.exampleId}`).toBeDefined();
      });

      if (!source) return;

      if (source.expectEscalation === 'No') {
        it('vernacular floor stays silent when the model is silent', () => {
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

      if (source.expectEscalation === 'Immediate') {
        it('vernacular floor escalates at TIER_3_ACUTE with the model silent', () => {
          const v = floorVerdict(row);
          expect(v).not.toBeNull();
          expect(v!.matchedBy).toBe('SERVER_KEYWORDS');
          expect(v!.intentId).toBe(source.expectIntentId);
          expect(v!.severity).toBe(SupportFlagSeverity.TIER_3_ACUTE);
          expect(v!.keywordEvidence.length).toBeGreaterThan(0);
        });
        return;
      }

      // Review-source rows: the floor stays silent, the model lane reviews.
      it('vernacular floor stays silent; the review rides on the model', () => {
        expect(floorVerdict(row)).toBeNull();
      });

      if (source.expectMatchedBy === 'AI_CATEGORY') {
        it(`model proposes ${source.modelCategory} → rule-bound review with human support`, () => {
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

  describe('corpus shape', () => {
    it('translates every SN row into all three languages', () => {
      const snIds = ESCALATION_CORPUS.filter((r) =>
        r.exampleId.startsWith('SN-'),
      ).map((r) => r.exampleId);
      expect(snIds).toHaveLength(60);
      expect(VERNACULAR_CORPUS).toHaveLength(180);
      for (const id of snIds) {
        for (const lang of ['yo', 'ha', 'ig'] as const) {
          expect(
            VERNACULAR_CORPUS.some((r) => r.exampleId === id && r.language === lang),
            `${id} [${lang}]`,
          ).toBe(true);
        }
      }
    });
  });
});
