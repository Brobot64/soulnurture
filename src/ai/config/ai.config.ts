import type { ConfigService } from '@nestjs/config';
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from '../guardrails/guardrails.config.js';
import type { QuickReplyValue } from '../../conversations/dto/send-message.dto.js';
import {
  ASR_VERNACULAR_LANGUAGES,
  DEFAULT_VERNACULAR_REPLY_MODE,
  SUPPORTED_LANGUAGES,
  type AsrVernacularLanguage,
  type SupportedLanguage,
  type VernacularReplyMode,
} from '../language/language.config.js';

/**
 * ---------------------------------------------------------------------------
 * AI config — the single place to read every AI knob.
 *
 * Override any value through environment variables (`.env.local` wins over
 * `.env`). Values here are non-secret: `GET /api/v1/ai/config` exposes this
 * whole structure (plus the registered intents) to professional roles so the
 * current behaviour is always explainable. Secrets (GROQ_API_KEY) never enter
 * this object.
 * ---------------------------------------------------------------------------
 */
export interface AiConfig {
  /** Prompt contract version; bump when the system prompt changes shape. */
  promptVersion: string;
  chat: {
    model: string;
    maxOutputTokens: number;
    temperature: number;
    /** First synchronous attempt budget before we fall back to the queue. */
    attemptTimeoutMs: number;
  };
  /** Ordered chain member names, e.g. ['openai', 'groq'] ('n-atlas' later). */
  chain: {
    order: string[];
  };
  openai: {
    model: string;
    maxOutputTokens: number;
  };
  pricing: {
    /** Estimated USD cents per 1M tokens, per provider — feeds AiUsageDaily. */
    usdCentsPer1M: Record<string, { input: number; output: number }>;
  };
  budget: {
    /** Once OpenAI serves this many generations in a server-local day, the
     * chain starts at the next member until the day rolls over. */
    openaiDailyRequestCap: number;
  };
  transcription: {
    model: string;
    /** Vernacular ASR back-ends (see providers/natlas/natlas-asr.provider.ts).
     * Per language a hosted HF Inference Endpoint wins over the self-hosted
     * sidecar; when neither is configured, voice notes in that language
     * degrade to the friendly "type it instead" message. */
    natlas: {
      /** HF Inference Endpoint root URLs, keyed by language code. */
      endpoints: Partial<Record<AsrVernacularLanguage, string>>;
      /** The self-hosted sidecar (services/n-atlas-asr); null = not deployed. */
      baseUrl: string | null;
      /** Cold starts load a whisper-small checkpoint; generous on purpose. */
      timeoutMs: number;
      languages: AsrVernacularLanguage[];
    };
  };
  /** OpenAI text embeddings — pgvector memory recall. Failure degrades the
   * memory layer to recency-only, never throws (see memory.repository.ts). */
  embedding: {
    model: string;
    timeoutMs: number;
  };
  /** Session-summary memory: idle close + recall windows (see
   * src/ai/memory/memory.repository.ts). */
  memory: {
    /** ACTIVE conversation untouched for this long → worker closes it and
     * queues a SUMMARY job. */
    idleMinutes: number;
    /** How far back recency recall + vector similarity look. */
    recallDays: number;
    /** Pending follow-up hooks stay eligible this long. */
    hookDays: number;
    maxRecents: number;
    maxHooks: number;
    maxSimilar: number;
    /** Cosine similarity floor for vector recall. */
    minSimilarity: number;
  };
  /** Session-summary generation budget (small JSON, see summarize.prompt.ts). */
  summaries: {
    maxOutputTokens: number;
  };
  /** Language layer (Phase C step 4): realtime detection, vernacular replies
   * and the async understanding lane (see src/ai/language/). */
  language: {
    /** Canonical codes the product replies in. */
    supported: SupportedLanguage[];
    /** When true, a message detected as vernacular while the preference is
     * still 'en' comes back with a languageOffer in the response. */
    offerEnabled: boolean;
    /** Reply lane for vernacular turns. 'n-atlas-translate' (default):
     * generation stays English and local N-ATLaS renders the finished reply
     * into the turn's language in the same request. 'openai-native': the
     * frontier model replies in the vernacular directly (rollback). */
    vernacularReplyMode: VernacularReplyMode;
    /** OpenAI-compatible N-ATLaS chat endpoint for the vernacular lane —
     * the hosted Hugging Face Inference Endpoint (vLLM) in production, any
     * OpenAI-shape server in dev; null → straight to the OpenAI fallback.
     * Auth key NATLAS_LLM_API_KEY is read via ConfigService in
     * natlas-llm.provider.ts and never stored here (AiConfig is public). */
    natlasBaseUrl: string | null;
    natlasModel: string;
    /** Per-attempt timeout for the N-ATLaS lane (ms) — generous on purpose:
     * the hosted endpoint scales to zero and cold starts queue; the worker
     * retry ladder covers whatever exceeds this. */
    natlasTimeoutMs: number;
    /** Per-attempt timeout for the synchronous reply render (ms). Short on
     * purpose — the student is waiting, so a cold endpoint must fall through
     * to the OpenAI render quickly. */
    natlasRenderTimeoutMs: number;
    /** Per-attempt timeout for the synchronous language-ID stage (ms). The
     * strictest of the three: it runs inside sendMessage before the reply
     * lane even starts, so on timeout the heuristics' verdict stands. */
    natlasIdentifyTimeoutMs: number;
    /** Synchronous translation deadline. N-ATLaS is the only translator; a
     * cold endpoint must not hold the reply, so past this the draft goes on the
     * original text and the second safety pass runs later. */
    natlasTranslateTimeoutMs: number;
    /** Strict output budget for the understanding contract (small JSON). */
    understandingMaxOutputTokens: number;
    /** Output budget for a rendered reply (the reply in another language). */
    renderMaxOutputTokens: number;
    /** Output budget for the language-ID reply (language header line plus a
     * short translation; the header prints first, so truncation is safe). */
    identifyMaxOutputTokens: number;
  };
  context: {
    /** Max recent messages replayed to the model. */
    messageLimit: number;
    /** Max total conversation characters replayed to the model. */
    characterLimit: number;
  };
  async: {
    /** Worker scan interval (ms). */
    pollMs: number;
    /** A PROCESSING job older than this is reclaimed (crash safety, ms). */
    staleClaimMs: number;
    /** Retry schedule for queued regenerations, ms between attempts. */
    retryDelaysMs: number[];
    /** What students see instantly when the model is unavailable. */
    holdingMessage: string;
  };
  safeguarding: {
    /**
     * Persist even uncategorised AI flag candidates (dashboard triage feed).
     * Server-policy (keyword) flags are persisted regardless.
     */
    persistModelCandidates: boolean;
  };
  /** Guided check-in replies: quick-reply directives + the turn budget.
   * Non-secret; exposed via GET /api/v1/ai/config so the guided behaviour
   * is explainable to professional roles. */
  guided: {
    /** Free-text turns allowed before wrap-up when no extension was used. */
    maxBaseTurns: number;
    /** Free-text turns allowed once the student tapped "Tell more" — and
     * the hard cap on TOTAL student turns (free text + quick replies):
     * the chat always wraps by this turn however the student got there. */
    maxExtendedTurns: number;
    /** The quick reply that extends the budget base → extended. */
    extension: QuickReplyValue;
    /** Per-quick-reply system-prompt directives (TELL_MORE is skipped on
     * the final turn — wrap-up outranks it). */
    directives: Record<QuickReplyValue, string>;
    /** Appended on the final turn of a guided check-in. */
    wrapUpDirective: string;
    /** REPLACES every guided directive while a support flag is OPEN on the
     * conversation — safeguarding outranks the guided experience. */
    flagDirective: string;
  };
  /** Reviewer surface for the configurable guardrail layer (see
   * guardrails/guardrails.config.ts). Non-secret; exposed via
   * GET /api/v1/ai/config so behaviour is explainable. */
  guardrails: GuardrailsConfig;
}

export const AI_CONFIG_DEFAULTS = {
  attemptTimeoutMs: 20_000,
  pollMs: 5_000,
  staleClaimMs: 120_000,
  /** First retry lands 5s later, then 30s, then 2m — attempt 4 fails job. */
  retryDelaysMs: [5_000, 30_000, 120_000],
  holdingMessage:
    'Thank you for sharing that with me — I am still thinking about it and will be right here.',
  guided: {
    maxBaseTurns: 3,
    maxExtendedTurns: 5,
    extension: 'TELL_MORE' as QuickReplyValue,
    directives: {
      TELL_MORE:
        'The student chose "Tell more". Invite them to share in their own words about their check-in. Reference what they told you. Ask exactly one gentle question. Never probe safeguarding details.',
      SHOW_IDEA:
        'The student asked for an idea. Offer one short, concrete, age-appropriate idea or encouragement tied to what they shared. Put it in reflection.insight.',
      TALK_TO_SOMEONE:
        'The student wants to talk to a person. Respond with the approved human-support bridge: praise the step, point to school counsellor / trusted adult. Keep it brief.',
    } satisfies Record<QuickReplyValue, string>,
    wrapUpDirective:
      "This is the student's final turn of this reflection. Close warmly, summarise what they shared, ask no further questions.",
    flagDirective:
      'A safeguarding concern is open for this student. Do not explore or probe. Use only the approved support and routing language.',
  },
} as const;

// Non-chat override defaults: reasoning models need room for thinking + JSON.
const DEFAULT_MAX_OUTPUT_TOKENS = 1000;

const DEFAULT_CHAIN = ['openai', 'groq'];

function parseVernacularReplyMode(raw: string | undefined): VernacularReplyMode {
  const value = raw?.trim().toLowerCase();
  if (value === 'n-atlas-translate' || value === 'openai-native') return value;
  return DEFAULT_VERNACULAR_REPLY_MODE;
}

export function buildAiConfig(config: ConfigService): AiConfig {
  const configuredChain = (config.get<string>('AI_PROVIDER_CHAIN') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  return {
    promptVersion: 'v3',
    chat: {
      model: config.get<string>('GROQ_CHAT_MODEL') ?? 'openai/gpt-oss-20b',
      maxOutputTokens: Number(
        config.get<string>('GROQ_MAX_OUTPUT_TOKENS') ??
          DEFAULT_MAX_OUTPUT_TOKENS,
      ),
      temperature: Number(config.get<string>('GROQ_TEMPERATURE') ?? 0.2),
      attemptTimeoutMs: AI_CONFIG_DEFAULTS.attemptTimeoutMs,
    },
    chain: {
      order: configuredChain.length > 0 ? configuredChain : [...DEFAULT_CHAIN],
    },
    openai: {
      model: config.get<string>('OPENAI_CHAT_MODEL') ?? 'gpt-5.6-luna',
      maxOutputTokens: Number(
        config.get<string>('OPENAI_MAX_OUTPUT_TOKENS') ??
          DEFAULT_MAX_OUTPUT_TOKENS,
      ),
    },
    pricing: {
      usdCentsPer1M: {
        openai: {
          input: Number(
            config.get<string>('OPENAI_INPUT_USD_CENTS_PER_1M') ?? 15,
          ),
          output: Number(
            config.get<string>('OPENAI_OUTPUT_USD_CENTS_PER_1M') ?? 60,
          ),
        },
        groq: {
          input: Number(
            config.get<string>('GROQ_INPUT_USD_CENTS_PER_1M') ?? 10,
          ),
          output: Number(
            config.get<string>('GROQ_OUTPUT_USD_CENTS_PER_1M') ?? 30,
          ),
        },
      },
    },
    budget: {
      openaiDailyRequestCap: Number(
        config.get<string>('OPENAI_DAILY_REQUEST_CAP') ?? 400,
      ),
    },
    transcription: {
      model:
        config.get<string>('GROQ_TRANSCRIPTION_MODEL') ??
        'whisper-large-v3-turbo',
      natlas: {
        endpoints: {
          yo: config.get<string>('NATLAS_ASR_URL_YO')?.trim() || undefined,
          ha: config.get<string>('NATLAS_ASR_URL_HA')?.trim() || undefined,
          ig: config.get<string>('NATLAS_ASR_URL_IG')?.trim() || undefined,
        },
        baseUrl: config.get<string>('NATLAS_ASR_BASE_URL')?.trim() || null,
        timeoutMs: Number(config.get<string>('NATLAS_ASR_TIMEOUT_MS') ?? 60_000),
        languages: [...ASR_VERNACULAR_LANGUAGES],
      },
    },
    embedding: {
      model:
        config.get<string>('OPENAI_EMBEDDING_MODEL') ??
        'text-embedding-3-small',
      timeoutMs: 10_000,
    },
    memory: {
      idleMinutes: Number(config.get<string>('AI_SESSION_IDLE_MINUTES') ?? 120),
      recallDays: 30,
      hookDays: 14,
      maxRecents: 2,
      maxHooks: 3,
      maxSimilar: 2,
      minSimilarity: 0.8,
    },
    summaries: {
      maxOutputTokens: 200,
    },
    language: {
      supported: [...SUPPORTED_LANGUAGES],
      offerEnabled:
        (config.get<string>('AI_LANGUAGE_OFFER_ENABLED') ?? 'true')
          .trim()
          .toLowerCase() !== 'false',
      vernacularReplyMode: parseVernacularReplyMode(
        config.get<string>('AI_VERNACULAR_REPLY_MODE'),
      ),
      natlasBaseUrl: config.get<string>('NATLAS_LLM_BASE_URL')?.trim() || null,
      natlasModel: config.get<string>('NATLAS_LLM_MODEL') ?? 'NCAIR1/N-ATLaS',
      natlasTimeoutMs: Number(
        config.get<string>('NATLAS_LLM_TIMEOUT_MS') ?? 45_000,
      ),
      natlasRenderTimeoutMs: Number(
        config.get<string>('NATLAS_RENDER_TIMEOUT_MS') ?? 12_000,
      ),
      natlasIdentifyTimeoutMs: Number(
        config.get<string>('NATLAS_IDENTIFY_TIMEOUT_MS') ?? 4_000,
      ),
      natlasTranslateTimeoutMs: Number(
        config.get<string>('NATLAS_TRANSLATE_TIMEOUT_MS') ?? 10_000,
      ),
      understandingMaxOutputTokens: 120,
      renderMaxOutputTokens: 400,
      identifyMaxOutputTokens: 64,
    },
    context: {
      messageLimit: Number(config.get<string>('AI_CONTEXT_MESSAGE_LIMIT') ?? 12),
      characterLimit: Number(
        config.get<string>('AI_CONTEXT_CHARACTER_LIMIT') ?? 12_000,
      ),
    },
    async: {
      pollMs: Number(config.get<string>('AI_ASYNC_POLL_MS') ?? 5_000),
      staleClaimMs: AI_CONFIG_DEFAULTS.staleClaimMs,
      retryDelaysMs: [...AI_CONFIG_DEFAULTS.retryDelaysMs],
      holdingMessage:
        config.get<string>('AI_ASYNC_HOLDING_MESSAGE') ??
        AI_CONFIG_DEFAULTS.holdingMessage,
    },
    safeguarding: {
      persistModelCandidates: true,
    },
    guided: {
      maxBaseTurns: Number(
        config.get<string>('AI_GUIDED_MAX_BASE_TURNS') ??
          AI_CONFIG_DEFAULTS.guided.maxBaseTurns,
      ),
      maxExtendedTurns: Number(
        config.get<string>('AI_GUIDED_MAX_EXTENDED_TURNS') ??
          AI_CONFIG_DEFAULTS.guided.maxExtendedTurns,
      ),
      extension: AI_CONFIG_DEFAULTS.guided.extension,
      directives: AI_CONFIG_DEFAULTS.guided.directives,
      wrapUpDirective: AI_CONFIG_DEFAULTS.guided.wrapUpDirective,
      flagDirective: AI_CONFIG_DEFAULTS.guided.flagDirective,
    },
    guardrails: {
      input: {
        maxMessageChars: Number(
          config.get<string>('AI_MAX_MESSAGE_CHARS') ??
            GUARDRAILS_DEFAULTS.maxMessageChars,
        ),
        truncationNote:
          'Long message — shown to the model in truncated form; the safeguarding review still sees the full original text.',
        injectionPatterns: GUARDRAILS_DEFAULTS.injectionPatterns,
        promptHardeningLine: GUARDRAILS_DEFAULTS.promptHardeningLine,
      },
      output: {
        maxReplyChars: Number(
          config.get<string>('AI_MAX_REPLY_CHARS') ??
            GUARDRAILS_DEFAULTS.maxReplyChars,
        ),
        truncationNote:
          'Reply exceeded the character cap and was cut — flagged for reviewer attention.',
        bannedClaims: GUARDRAILS_DEFAULTS.bannedClaims,
        fallbackCopy: GUARDRAILS_DEFAULTS.fallbackCopy,
      },
      rate: {
        perStudentDaily: Number(
          config.get<string>('AI_RATE_LIMIT_DAILY') ??
            GUARDRAILS_DEFAULTS.perStudentDaily,
        ),
        perStudentPerMinute: Number(
          config.get<string>('AI_RATE_LIMIT_PER_MINUTE') ??
            GUARDRAILS_DEFAULTS.perStudentPerMinute,
        ),
        limitMessage:
          'You have sent quite a few messages in a short time — let us take a short pause so I can give each one proper attention. You can always reach a school counsellor right away through Support; they are there for you even while I rest.',
      },
    },
  };
}

export const AI_CONFIG = Symbol('AI_CONFIG');
