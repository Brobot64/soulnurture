import { Inject, Injectable } from '@nestjs/common';
import { AiContextService } from './context/ai-context.service.js';
import { GuardrailService } from './guardrails/guardrail.service.js';
import {
  SYSTEM_PROMPT,
  REFLECTION_PROMPT_VERSION,
} from './prompts/system.prompt.js';
import { IntentEngineService } from './intents/intent-engine.service.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_SEVERITIES,
} from './intents/intents.config.js';
import { applyIntentVerdict } from './intents/intent-executors.js';
import type { IntentVerdict } from './intents/intent-engine.service.js';
import type { AiContext } from './context/ai-context.service.js';
import { validateAiResponse } from './schemas/validate-ai-response.js';
import { AiGenerationError } from './ai.errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_PROVIDER,
  type AiProvider,
  type AiGenerationResult,
  type AiTranscriptionResult,
} from './providers/ai-provider.interface.js';

/**
 * Full AI orchestration for one message: context → provider → schema
 * validation → intent evaluation & actions → resource whitelist.
 *
 * Generation failures throw AiGenerationError so the conversation lane can
 * dispatch an instant holding reply and queue the real response (async lane).
 * Intent keyword detection runs on every validated result, so safeguarding
 * state materialises regardless of what the model said (the model is never
 * the only line of defence).
 */
export interface AiOrchestrationInput {
  studentId: string;
  conversationId: string;
  checkInId?: string | null;
  userContent: string;
  language?: string;
  studentRef: string;
  classLabel: string | null;
}

export interface AiOrchestrationOutcome {
  result: AiGenerationResult;
  context: AiContext;
  verdict: IntentVerdict | null;
  notes: string[];
}

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly contextService: AiContextService,
    private readonly intentEngine: IntentEngineService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly guardrail: GuardrailService,
  ) {}

  async generateAndApply(
    input: AiOrchestrationInput,
  ): Promise<AiOrchestrationOutcome> {
    const ctx = await this.contextService.build({
      studentId: input.studentId,
      conversationId: input.conversationId,
      checkInId: input.checkInId,
    });

    // Input guardrail: the model sees the truncated message; the intent floor
    // below still evaluates the RAW userContent — safety is never truncated.
    const sanitized = this.guardrail.sanitizeInput(input.userContent);

    const systemPrompt = [
      SYSTEM_PROMPT,
      `Prompt version: ${REFLECTION_PROMPT_VERSION}`,
      `Language: ${input.language ?? ctx.student.preferredLanguage ?? 'en'}`,
      `Valid supportFlag.category values: ${CANONICAL_CATEGORIES.join(', ')}`,
      `Valid supportFlag.severity values: ${CANONICAL_SEVERITIES.join(', ')}`,
      `Approved context JSON: ${JSON.stringify(ctx)}`,
      ...(sanitized.injected
        ? [this.guardrail.promptHardeningLine()]
        : []),
    ].join('\n\n');

    const messages = [
      ...ctx.recentConversation.map((m) => ({
        role: (m.role === 'USER' ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: sanitized.content },
    ];

    let raw: unknown;
    try {
      raw = await this.provider.generateResponse({
        systemPrompt,
        messages,
        language: input.language,
      });
    } catch (error) {
      throw new AiGenerationError('AI generation unavailable', {
        cause: error,
      });
    }

    const result = validateAiResponse(raw);

    // Output guardrail runs before the intent engine so verdict/executors and
    // the stored aiPayload only ever see the filtered reply.
    const filtered = this.guardrail.filterOutput(result.message);
    result.message = filtered.reply;

    const verdict = this.intentEngine.evaluate({
      userContent: input.userContent,
      aiResult: result,
    });

    const notes: string[] = [...sanitized.notes, ...filtered.notes];
    if (verdict) {
      notes.push(
        ...(await applyIntentVerdict(verdict, {
          prisma: this.prisma,
          auditService: this.auditService,
          result,
          studentId: input.studentId,
          studentRef: input.studentRef,
          classLabel: input.classLabel,
          conversationId: input.conversationId,
          userContent: input.userContent,
          relevantResources: ctx.relevantResources,
        })),
      );
    }

    // Final whitelist: the model may never reference an unapproved resource.
    if (result.resource.recommended && result.resource.resourceId) {
      const allowed = new Set(ctx.relevantResources.map((r) => r.id));
      if (!allowed.has(result.resource.resourceId)) {
        result.resource.resourceId = null;
        result.resource.recommended = false;
        notes.push('Stripped unapproved resource id from model output.');
      }
    }

    // Server extras are owned by us, never trusted from the model.
    result.asyncState = 'COMPLETE';

    return { result, context: ctx, verdict, notes };
  }

  async transcribe(file: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    language?: string;
  }): Promise<AiTranscriptionResult> {
    return this.provider.transcribeAudio(file);
  }
}
