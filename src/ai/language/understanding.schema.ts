import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AiGenerationError } from '../ai.errors.js';
import type { SupportedLanguage } from './language.config.js';

/**
 * Understanding contract (Phase C step 4): what the vernacular translation
 * lane must return for a non-English message. Deliberately tiny — the
 * translation feeds a safeguarding second pass and later summaries, so
 * literal fidelity beats flourish; the coarse tone enum keeps even a small
 * local model inside the schema.
 */
export const UnderstandingResultSchema = z.object({
  englishTranslation: z.string().min(1).max(600),
  tone: z.enum(['CALM', 'DISTRESSED', 'PANICKED', 'HOPELESS', 'ANGRY', 'NEUTRAL']),
  keyFacts: z.array(z.string().min(1).max(120)).max(5),
});

export type UnderstandingResult = z.output<typeof UnderstandingResultSchema>;

export type UnderstandingVia = 'n-atlas-local' | 'openai';

/** What gets stored under `aiPayload.understanding` on the student message. */
export interface MessageUnderstanding extends UnderstandingResult {
  /** Language the detector attributed to the message. */
  lang: SupportedLanguage;
  /** Which translation lane produced this understanding. */
  via: UnderstandingVia;
}

/** Structured-output override for OpenAI (local Ollama gets `format: json`). */
export const UNDERSTANDING_JSON_SCHEMA = {
  name: 'message_understanding',
  strict: true,
  schema: zodToJsonSchema(UnderstandingResultSchema, {
    $refStrategy: 'none',
  }),
} as const;

export function validateUnderstanding(raw: unknown): UnderstandingResult {
  const parsed = UnderstandingResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new AiGenerationError(
      `AI message understanding failed schema validation (${issues})`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
