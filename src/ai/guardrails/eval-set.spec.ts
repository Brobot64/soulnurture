import type { ConfigService } from '@nestjs/config';
import { buildAiConfig } from '../config/ai.config.js';
import { IntentEngineService } from '../intents/intent-engine.service.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import { GUARDRAILS_DEFAULTS } from './guardrails.config.js';
import { GuardrailService } from './guardrail.service.js';
import {
  CANNED_VIOLATIONS,
  EVAL_COUNTS,
  EVAL_SET,
  type EvalLane,
} from './__fixtures__/eval-set.js';

function createService() {
  const aiConfig = buildAiConfig({
    get: () => undefined,
  } as unknown as ConfigService);
  return new GuardrailService(aiConfig);
}

const engine = new IntentEngineService();

/** What the model said when it proposed no flag — engine layer 1 must still fire. */
const NEUTRAL_AI_RESULT = {
  supportFlag: { candidate: false, category: null, severity: null },
} as unknown as AiGenerationResult;

function laneMessages(lane: EvalLane) {
  return EVAL_SET.filter((message) => message.lane === lane);
}

describe('eval corpus — shape', () => {
  it('has exactly the contracted lane counts and unique ids', () => {
    for (const [lane, expected] of Object.entries(EVAL_COUNTS)) {
      expect(laneMessages(lane as EvalLane)).toHaveLength(expected);
    }
    const ids = EVAL_SET.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_SET).toHaveLength(70);
  });
});

describe('eval corpus — crisis recall (server layer, model-independent)', () => {
  it.each(laneMessages('crisis').map((m) => [m.id, m.text] as const))(
    '%s produces an intent verdict',
    (_id, text) => {
      const verdict = engine.evaluate({
        userContent: text,
        aiResult: NEUTRAL_AI_RESULT,
      });
      expect(verdict).not.toBeNull();
      expect(verdict!.matchedBy).toBe('SERVER_KEYWORDS');
    },
  );
});

describe('eval corpus — normal/boundary lanes stay quiet', () => {
  it.each(
    [...laneMessages('normal'), ...laneMessages('boundary')].map(
      (m) => [m.id, m.text] as const,
    ),
  )(
    '%s passes the input lane with no flags and no intent verdict',
    (_id, text) => {
      const service = createService();
      const out = service.sanitizeInput(text);
      expect(out.injected).toBe(false);
      expect(out.notes).toEqual([]);
      expect(out.content).toBe(text);

      const verdict = engine.evaluate({
        userContent: text,
        aiResult: NEUTRAL_AI_RESULT,
      });
      expect(verdict).toBeNull();
    },
  );
});

describe('eval corpus — privacy probes are neutralised, never blocked', () => {
  it.each(laneMessages('privacy').map((m) => [m.id, m.text] as const))(
    '%s sets injected with a reviewer note and keeps the content answerable',
    (_id, text) => {
      const service = createService();
      const out = service.sanitizeInput(text);
      expect(out.injected).toBe(true);
      expect(out.notes.join(' ')).toContain('probe');
      // Probes reach the model untouched — the hardening line does the defence.
      expect(out.content).toBe(text);
    },
  );
});

describe('eval corpus — boundary enforcement on canned violating outputs', () => {
  it.each(CANNED_VIOLATIONS.map((v) => [v.id, v] as const))(
    '%s is caught by the output filter, not by model luck',
    (_id, violation) => {
      const service = createService();
      const claim = GUARDRAILS_DEFAULTS.bannedClaims.find(
        (candidate) => candidate.id === violation.claimId,
      )!;
      const out = service.filterOutput(violation.cannedReply);

      expect(out.violations).toContain(violation.claimId);
      expect(out.notes.length).toBeGreaterThan(0);

      if (claim.severity === 'severe') {
        // Whole reply replaced with scripted copy — nothing of the original.
        expect(out.reply).toBe(claim.replacement ?? GUARDRAILS_DEFAULTS.fallbackCopy);
        expect(out.reply).not.toBe(violation.cannedReply);
      } else {
        // Soft: offending sentence(s) gone, claim patterns no longer match.
        expect(out.reply).not.toBe(violation.cannedReply);
        for (const pattern of claim.patterns) {
          expect(new RegExp(pattern, 'i').test(out.reply)).toBe(false);
        }
      }
    },
  );
});
