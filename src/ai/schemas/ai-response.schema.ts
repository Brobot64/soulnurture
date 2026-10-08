import { z } from 'zod';

export const AiGenerationResultSchema = z.object({
  message: z.string().min(1),
  emotion: z
    .object({
      detected: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
    })
    .strict(),
  reflection: z
    .object({
      question: z.string().nullable(),
      insight: z.string().nullable(),
    })
    .strict(),
    resource: z
    .object({
      recommended: z.boolean(),
      resourceId: z.string().nullable(),
    })
    .strict(),
  humanSupport: z
    .object({
      recommended: z.boolean(),
      type: z.string().nullable(),
      reason: z.string().nullable(),
    })
    .strict(),
  supportFlag: z
    .object({
      candidate: z.boolean(),
      category: z.string().nullable(),
      severity: z.string().nullable(),
    })
    .strict(),
  action: z.enum([
    'NONE',
    'REFLECTION',
    'GROUNDING',
    'RESOURCE',
    'HUMAN_SUPPORT',
  ]),
  usage: z
    .object({
      inputTokens: z.number().int().positive().optional(),
      outputTokens: z.number().int().positive().optional(),
      latencyMs: z.number().int().positive().optional(),
      audioDuration: z.number().int().positive().optional(),
      // Server-stamped by the provider chain after serving (explainability);
      // never part of the model-facing contract, which omits `usage` entirely.
      provider: z.string().optional(),
    })
    .strict()
    .optional(),
});

export type AiGenerationResultInput = z.input<typeof AiGenerationResultSchema>;
export type AiGenerationResultOutput = z.output<typeof AiGenerationResultSchema>;

