import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AiGenerationError } from '../ai.errors.js';

/**
 * Hand-off entry contract (Phase 6): the professional-facing opening note a
 * student's chat request carries into the shared pool. One short field —
 * everything else about the request is structured data the pool already has.
 */
export const HandoffEntryResultSchema = z.object({
  message: z.string().min(1).max(500),
});

export type HandoffEntryResult = z.output<typeof HandoffEntryResultSchema>;

/** Structured-output override the chain passes to OpenAI for hand-offs. */
export const HANDOFF_ENTRY_JSON_SCHEMA = {
  name: 'handoff_entry_result',
  strict: true,
  schema: zodToJsonSchema(HandoffEntryResultSchema, { $refStrategy: 'none' }),
} as const;

export function validateHandoffEntry(raw: unknown): HandoffEntryResult {
  const parsed = HandoffEntryResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AiGenerationError(
      `AI handoff entry failed schema validation (${issues})`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
