import type { ConfigService } from '@nestjs/config';
import {
  GUARDRAILS_DEFAULTS,
  type GuardrailsConfig,
} from '../guardrails/guardrails.config.js';

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
} as const;

// Non-chat override defaults: reasoning models need room for thinking + JSON.
const DEFAULT_MAX_OUTPUT_TOKENS = 1000;

const DEFAULT_CHAIN = ['openai', 'groq'];

export function buildAiConfig(config: ConfigService): AiConfig {
  const configuredChain = (config.get<string>('AI_PROVIDER_CHAIN') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  return {
    promptVersion: 'v2',
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
