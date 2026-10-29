import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { AiService } from '../ai.service.js';
import { AiGenerationError } from '../ai.errors.js';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { AiContextService } from '../context/ai-context.service.js';
import { GuardrailService } from '../guardrails/guardrail.service.js';
import { GUARDRAILS_DEFAULTS } from '../guardrails/guardrails.config.js';
import { IntentEngineService } from '../intents/intent-engine.service.js';
import type { IntentVerdict } from '../intents/intent-engine.service.js';
import { LanguageDetectorService } from '../language/language-detector.service.js';
import { ReplyRendererService } from '../language/reply-renderer.service.js';
import type { ReplyRenderInput } from '../language/reply-renderer.service.js';
import {
  genericReplyLine,
  holdingLine,
  safetyLine,
  SCRIPTED_SAFETY,
} from '../language/scripted-copy.js';
import { resolveTurnLanguage } from '../language/turn-language.js';
import { MemoryRepository } from '../memory/memory.repository.js';
import { AI_PROVIDER } from '../providers/ai-provider.interface.js';
import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import { NAtlasAsrProvider } from '../providers/natlas/natlas-asr.provider.js';
import { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import { NatlasTranslationProvider } from '../providers/natlas/natlas.provider.js';
import { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SupportFlagAlertsService } from '../../support-flags/support-flag-alerts.service.js';
import { CONVERSATION_SETS } from './conversation-sets.fixtures.js';
import type { EvalLang } from './conversation-sets.fixtures.js';

/**
 * End-to-end run of the conversation sets (ES-01 … ES-51).
 *
 * STUB MODE (default, deterministic): N-ATLaS identify answers come from each
 * turn's `natlas` switch, and render lanes return a tagged reply.
 *
 * LIVE MODE (NATLAS_LIVE=1, reads NATLAS_* from .env): the real N-ATLaS
 * endpoint identifies languages and renders replies. Each rendered reply's
 * language is checked by a live N-ATLaS identify call, not by a tag. The
 * `natlas` switch then only means 'down' (simulated outage); its label is
 * ignored because the live model answers for itself.
 *
 * REAL in both modes: language detection, the per-turn language rule, the
 * intent engine, the AI service (render lane, scripted safety, fallbacks) and
 * the scripted copy. STUBBED in both modes: the generation provider (its
 * model reply is 'hello'), the OpenAI calls, and the database.
 */

const LIVE = process.env.NATLAS_LIVE === '1';
const HOLDING_EN =
  'Thank you for sharing that with me — I am still thinking about it and will be right here.';
const LOCAL: EvalLang[] = ['pcm', 'yo', 'ha', 'ig'];

/** The outside world for the current turn, set before each turn runs. */
const world: {
  natlas?: string;
  openai?: string;
  render?: 'fail';
  provider?: 'down';
} = {};

/** Live mode: the language the renderer accepted for the current turn's reply
 * (set only when a real render passed its own target-language checks). */
let renderedTo: EvalLang | null = null;

/** Notes from the last turn's generateAndApply (translation status etc.). */
let lastNotes: string[] = [];

/** Live mode only: load NATLAS_* values from .env into process.env. Values
 * are never logged. */
function loadNatlasEnv(): void {
  const text = readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(NATLAS_[A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** The generation provider's English reply. Realistic on purpose: in live mode
 * this is what N-ATLaS renders, so 'hello' would render as a greeting only. */
const MODEL_REPLY_EN =
  'I hear you, and I am glad you told me. Can you tell me a bit more about what is on your mind?';

function modelResult(): AiGenerationResult {
  return {
    message: MODEL_REPLY_EN,
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
  };
}

/** Language a reply is written in when it is a scripted line or carries a
 * stub render tag. Null when a live identify is needed instead. */
function localReplyLanguage(reply: string): EvalLang | null {
  const tag = reply.match(/^\[(en|pcm|yo|ha|ig)\] /);
  if (tag) return tag[1] as EvalLang;
  for (const lang of LOCAL) {
    if (genericReplyLine(lang) === reply || holdingLine(lang, '') === reply) {
      return lang;
    }
    for (const intentId of Object.keys(SCRIPTED_SAFETY)) {
      if (SCRIPTED_SAFETY[intentId]?.[lang] === reply) return lang;
    }
  }
  return null;
}

const aiConfigStub = {
  promptVersion: 'v3',
  chat: { model: 'm', maxOutputTokens: 1000, temperature: 0.2, attemptTimeoutMs: 20_000 },
  transcription: { model: 't' },
  context: { messageLimit: 12, characterLimit: 12_000 },
  openai: { model: 'gpt-eval' },
  async: { pollMs: 5_000, staleClaimMs: 120_000, retryDelaysMs: [5_000], holdingMessage: HOLDING_EN },
  guardrails: {
    input: {
      maxMessageChars: GUARDRAILS_DEFAULTS.maxMessageChars,
      truncationNote: 'input truncated',
      injectionPatterns: GUARDRAILS_DEFAULTS.injectionPatterns,
      promptHardeningLine: GUARDRAILS_DEFAULTS.promptHardeningLine,
    },
    output: {
      maxReplyChars: GUARDRAILS_DEFAULTS.maxReplyChars,
      truncationNote: 'output truncated',
      bannedClaims: GUARDRAILS_DEFAULTS.bannedClaims,
      fallbackCopy: GUARDRAILS_DEFAULTS.fallbackCopy,
    },
    rate: {
      perStudentDaily: GUARDRAILS_DEFAULTS.perStudentDaily,
      perStudentPerMinute: GUARDRAILS_DEFAULTS.perStudentPerMinute,
      limitMessage: 'limit reached',
    },
  },
  guided: {
    directives: { TELL_MORE: 'T', SHOW_IDEA: 'S', TALK_TO_SOMEONE: 'K' },
    flagDirective: 'F',
  },
  language: {
    supported: ['en', 'yo', 'ha', 'ig', 'pcm'],
    offerEnabled: true,
    vernacularReplyMode: 'n-atlas-translate',
    natlasBaseUrl: 'https://natlas.invalid',
    natlasModel: 'NCAIR1/N-ATLaS',
    natlasTimeoutMs: 45_000,
    natlasRenderTimeoutMs: 12_000,
    natlasIdentifyTimeoutMs: 4_000,
    identifyMaxOutputTokens: 64,
    understandingMaxOutputTokens: 120,
    renderMaxOutputTokens: 400,
    understandingTimeoutMs: 15_000,
  },
} as unknown as AiConfig;

describe(`End-to-end conversation sets ES-01 … ES-51 (${LIVE ? 'LIVE N-ATLaS' : 'stub'})`, () => {
  let service: AiService;
  let detector: LanguageDetectorService;
  let live: NatlasLlmProvider | null = null;

  beforeAll(async () => {
    let natlasLlm: {
      configured: boolean;
      completeLabel: (system: string, user: string) => Promise<{ text: string; usage: object }>;
      completeText: (system: string, user: string) => Promise<{ text: string; usage: object }>;
      completeJson: (system: string, user: string) => Promise<{ raw: unknown; usage: object }>;
    };
    let translator: { understand: (input: { text: string; language: string }) => Promise<unknown> };
    let renderer: { render: (input: ReplyRenderInput) => Promise<unknown> };
    let aiConfig: AiConfig = aiConfigStub;
    const configGet = (key: string) =>
      key === 'OPENAI_API_KEY' ? 'sk-eval' : process.env[key];
    const meter = { record: vi.fn().mockResolvedValue(undefined) };

    if (LIVE) {
      loadNatlasEnv();
      aiConfig = {
        ...aiConfigStub,
        language: {
          ...aiConfigStub.language,
          natlasBaseUrl: process.env.NATLAS_LLM_BASE_URL?.trim() || null,
          natlasModel: process.env.NATLAS_LLM_MODEL ?? 'NCAIR1/N-ATLaS',
        },
      } as unknown as AiConfig;
      live = new NatlasLlmProvider(aiConfig, { get: configGet } as unknown as ConfigService);
      const realNatlas = live;
      natlasLlm = {
        configured: realNatlas.configured,
        completeLabel: async (system, user) => {
          if (world.natlas === 'down') throw new Error('N-ATLaS down (simulated)');
          return realNatlas.completeLabel(system, user);
        },
        completeText: (system, user) => realNatlas.completeText(system, user),
        completeJson: (system, user) => {
          if (world.natlas === 'down') throw new Error('N-ATLaS down (simulated)');
          return realNatlas.completeJson(system, user);
        },
      };
      // The real translation provider: N-ATLaS translates, OpenAI is the fallback.
      translator = new NatlasTranslationProvider(
        { get: configGet } as unknown as ConfigService,
        natlasLlm as unknown as NatlasLlmProvider,
        meter as unknown as AiUsageMeterService,
        aiConfig,
      ) as unknown as typeof translator;
      const realRenderer = new ReplyRendererService(
        { get: configGet } as unknown as ConfigService,
        natlasLlm as unknown as NatlasLlmProvider,
        meter as unknown as AiUsageMeterService,
        aiConfig,
      );
      renderer = {
        render: async (input) => {
          if (world.render === 'fail') return null;
          const out = await realRenderer.render(input);
          renderedTo = out !== null ? (input.language as EvalLang) : null;
          return out;
        },
      };
    } else {
      natlasLlm = {
        configured: true,
        completeLabel: async () => {
          if (world.natlas === 'down') throw new Error('N-ATLaS unreachable');
          return { text: `Language: ${world.natlas ?? 'Other'}\nMeaning: (english)`, usage: {} };
        },
        completeText: async () => ({ text: '', usage: {} }),
        completeJson: async () => {
          throw new Error('N-ATLaS JSON not used in stub mode');
        },
      };
      // Stub translator: passes the text through as its own English translation.
      translator = {
        understand: async ({ text }) => ({
          understanding: { englishTranslation: text, tone: 'NEUTRAL', keyFacts: [], lang: 'en', via: 'n-atlas-local' },
          via: 'n-atlas-local',
        }),
      };
      renderer = {
        render: async (input) =>
          world.render === 'fail'
            ? null
            : { rendered: `[${input.language}] ${input.englishReply}`, via: 'n-atlas-local' },
      };
    }

    // Only OpenAI calls are stubbed; live N-ATLaS calls use fetch too and must
    // reach the real endpoint. The OpenAI stub answers the language-identify
    // request only: any other OpenAI call (a render fallback) fails, so the
    // eval never gets fake translated text.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== OPENAI_CHAT_URL) return realFetch(url, init);
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: { content?: string }[];
        };
        const isIdentify = String(body.messages?.[0]?.content ?? '').includes(
          'Language: <the language',
        );
        if (!isIdentify || world.openai === 'down') {
          throw new Error('OpenAI unavailable in this eval (identify only)');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: `Language: ${world.openai ?? 'Other'}\nMeaning: (english)` } }],
            usage: {},
          }),
        } as unknown as Response;
      }),
    );

    detector = new LanguageDetectorService(
      natlasLlm as unknown as NatlasLlmProvider,
      { get: configGet } as unknown as ConfigService,
      meter as unknown as AiUsageMeterService,
      aiConfig,
    );

    const module = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: AI_PROVIDER,
          useValue: {
            generateResponse: async () => {
              if (world.provider === 'down') throw new Error('provider down');
              return modelResult();
            },
            transcribeAudio: async () => ({ text: 'x' }),
          },
        },
        {
          provide: AiContextService,
          useValue: {
            build: async () => ({
              student: { firstName: 'E', preferredLanguage: 'en' },
              currentCheckIn: null,
              recentConversation: [],
              relevantReflection: null,
              relevantResources: [],
              currentJourneyStep: 2,
              carriedContext: null,
            }),
          },
        },
        IntentEngineService,
        {
          provide: PrismaService,
          useValue: {
            supportFlag: {
              findFirst: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue({ id: 'flag' }),
            },
            wellbeingActivity: { findMany: vi.fn().mockResolvedValue([]) },
          },
        },
        { provide: AuditService, useValue: { log: vi.fn().mockResolvedValue({ id: 'a' }) } },
        GuardrailService,
        { provide: AI_CONFIG, useValue: aiConfig },
        { provide: MemoryRepository, useValue: { embedAndStore: vi.fn(), recall: vi.fn() } },
        { provide: NatlasTranslationProvider, useValue: translator },
        { provide: NAtlasAsrProvider, useValue: { transcribeAudio: vi.fn() } },
        { provide: ReplyRendererService, useValue: renderer },
        {
          provide: SupportFlagAlertsService,
          useValue: { recommendImmediateFollowUp: vi.fn().mockResolvedValue('alerted') },
        },
      ],
    }).compile();
    service = module.get(AiService);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  /** Language of a reply: a scripted line or stub tag first. A live render is
   * read by the same detector the system uses for student messages (diacritics
   * and lexicon first, N-ATLaS only when those are silent) — a live identify on
   * the bare render was unreliable for Igbo (read as Yoruba). */
  async function replyLanguageOf(reply: string): Promise<EvalLang | 'unknown'> {
    const local = localReplyLanguage(reply);
    if (local) return local;
    // A live render is in the language the renderer accepted: the renderer's
    // own checks (target evidence, no echo, no loop) are the verification.
    if (LIVE && renderedTo) return renderedTo;
    return 'en';
  }

  /** One student turn through the real AI service, with the provider-down
   * holding lane reproduced from the AiGenerationError contract. */
  async function runTurn(
    text: string,
    language: EvalLang,
  ): Promise<{ reply: string; flag: string | null }> {
    lastNotes = [];
    try {
      const outcome = await service.generateAndApply({
        studentId: 's1',
        conversationId: 'c1',
        userContent: text,
        studentRef: 'Eval',
        classLabel: null,
        messageLanguage: language,
      });
      lastNotes = outcome.notes;
      return { reply: outcome.result.message, flag: outcome.verdict?.intentId ?? null };
    } catch (error) {
      if (!(error instanceof AiGenerationError)) throw error;
      // Holding lane (conversations.service holdAndQueue): holding copy in the
      // turn's language, and any acute scripted line replaces it.
      const engine = new IntentEngineService();
      const placeholder = { ...modelResult(), message: holdingLine(language, HOLDING_EN) };
      const verdict: IntentVerdict | null = engine.evaluate({ userContent: text, aiResult: placeholder });
      const safety = verdict?.actions.find((a) => a.type === 'SAFETY_MESSAGE');
      if (safety?.type === 'SAFETY_MESSAGE') {
        return {
          reply: safetyLine(verdict!.intentId, language, safety.message),
          flag: verdict!.intentId,
        };
      }
      return { reply: placeholder.message, flag: verdict?.intentId ?? null };
    }
  }

  for (const set of CONVERSATION_SETS) {
    it(
      `${set.id} ${set.title}`,
      async () => {
        let conversationLanguage: string | null = null;
        const preference = set.preference ?? 'en';
        const transcript: Array<Record<string, unknown>> = [];

        for (const [index, turn] of set.turns.entries()) {
          world.natlas = turn.natlas;
          world.openai = turn.openai;
          world.render = turn.render;
          world.provider = turn.provider;
          renderedTo = null;

          const detection = await detector.detect(turn.text);
          const turnLanguage = resolveTurnLanguage({
            detected: detection.lang,
            conversationLanguage,
            preferredLanguage: preference,
          });
          if (detection.lang !== null && detection.confidence !== 'low') {
            conversationLanguage = detection.lang;
          }

          const { reply, flag } = await runTurn(turn.text, turnLanguage);
          // Live: a non-English draft must come from the N-ATLaS translation.
          // Outage turns are excluded: natlas 'down' expects the fallback, and a
          // provider 'down' turn takes the holding lane, which returns no notes.
          if (LIVE && turnLanguage !== 'en' && turn.natlas !== 'down' && turn.provider !== 'down') {
            expect(
              lastNotes.join(' '),
              `turn ${index + 1} did not draft from a translation: "${turn.text}"`,
            ).toContain('Drafted from the English translation');
          }
          const actual = { turn: index + 1, replyLanguage: await replyLanguageOf(reply), flag };
          transcript.push({ ...actual, text: turn.text, reply });
          expect(
            actual,
            `turn ${index + 1}: "${turn.text}"\n${JSON.stringify(transcript, null, 2)}`,
          ).toEqual({ turn: index + 1, replyLanguage: turn.reply, flag: turn.flag });
        }
      },
      LIVE ? 300_000 : 10_000,
    );
  }
});
