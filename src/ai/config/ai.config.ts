import type { ConfigService } from '@nestjs/config';

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
  transcription: {
    model: string;
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

export function buildAiConfig(config: ConfigService): AiConfig {
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
    transcription: {
      model:
        config.get<string>('GROQ_TRANSCRIPTION_MODEL') ??
        'whisper-large-v3-turbo',
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
  };
}

export const AI_CONFIG = Symbol('AI_CONFIG');
