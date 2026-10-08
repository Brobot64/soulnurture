import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CANONICAL_TOPICS } from '../intents/intents.config.js';
import { AiGenerationError } from '../ai.errors.js';

/**
 * Session-summary contract (Phase C step 3): what the summary writer must
 * return after a conversation closes. Deliberately small — this feeds the
 * pgvector memory, so precision beats coverage. `followUpHook` is a gentle,
 * non-clinical nudge a later conversation can pick up.
 */
export const SessionSummaryResultSchema = z.object({
  summary: z.string().min(1).max(400),
  topics: z.array(z.enum(CANONICAL_TOPICS)).max(6),
  followUpHook: z.string().max(140).nullable(),
  emotionalTrend: z.enum(['CALMER', 'HEAVIER', 'UNCHANGED']),
});

export type SessionSummaryResult = z.output<typeof SessionSummaryResultSchema>;

/** Structured-output override the chain passes to OpenAI for summaries. */
export const SUMMARY_JSON_SCHEMA = {
  name: 'session_summary_result',
  strict: true,
  schema: zodToJsonSchema(SessionSummaryResultSchema, {
    $refStrategy: 'none',
  }),
} as const;

export function validateSessionSummary(raw: unknown): SessionSummaryResult {
  const parsed = SessionSummaryResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AiGenerationError(
      `AI session summary failed schema validation (${issues})`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
