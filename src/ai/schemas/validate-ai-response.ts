import type { AiGenerationResult } from '../providers/ai-provider.interface.js';
import { AiGenerationError } from '../ai.errors.js';
import { AiGenerationResultSchema } from './ai-response.schema.js';

/**
 * Validates raw model output against the response contract.
 * Throws AiGenerationError on invalid output so callers can fall back to the
 * async retry pipeline (never trust the model — the response must be exact).
 */
export function validateAiResponse(raw: unknown): AiGenerationResult {
  const parsed = AiGenerationResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AiGenerationError(
      `AI output failed schema validation (${issues})`,
      { cause: parsed.error },
    );
  }
  return parsed.data as unknown as AiGenerationResult;
}
