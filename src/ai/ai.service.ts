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
  CANONICAL_TOPICS,
} from './intents/intents.config.js';
import { applyIntentVerdict } from './intents/intent-executors.js';
import type { IntentVerdict } from './intents/intent-engine.service.js';
import type { AiContext } from './context/ai-context.service.js';
import { validateAiResponse } from './schemas/validate-ai-response.js';
import { AiGenerationError } from './ai.errors.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { filterSummaryText } from './memory/summary-guard.js';
import {
  SUMMARY_JSON_SCHEMA,
  validateSessionSummary,
} from './memory/session-summary.schema.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_PROMPT_VERSION,
} from './memory/summarize.prompt.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
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

export interface SummarizeConversationInput {
  studentId: string;
  conversationId: string;
}

export interface SummarizeConversationOutcome {
  summaryId: string;
  notes: string[];
  embedded: boolean;
}

const SUMMARY_FALLBACK =
  'The student talked with Soul Nurture about their wellbeing.';

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly contextService: AiContextService,
    private readonly intentEngine: IntentEngineService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly guardrail: GuardrailService,
    private readonly memory: MemoryRepository,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async generateAndApply(
    input: AiOrchestrationInput,
  ): Promise<AiOrchestrationOutcome> {
    const ctx = await this.contextService.build({
      studentId: input.studentId,
      conversationId: input.conversationId,
      checkInId: input.checkInId,
      currentMessageText: input.userContent,
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

  /**
   * Session-summary writer (Phase C step 3). Runs on conversation close —
   * from the close endpoint or the worker's SUMMARY job — and persists the
   * digest that feeds pgvector memory recall. Model output is schema-
   * validated, then passed through the low-sensitivity summary guard before
   * anything is stored. Embedding is best-effort: a cold embedding provider
   * leaves the row recallable via recency only.
   */
  async summarizeConversation(
    input: SummarizeConversationInput,
  ): Promise<SummarizeConversationOutcome> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: input.conversationId, studentId: input.studentId },
      select: { id: true },
    });
    if (!conversation) {
      throw new AiGenerationError(
        `Conversation ${input.conversationId} not found for student`,
      );
    }

    const existing = await this.prisma.sessionSummary.findUnique({
      where: { conversationId: input.conversationId },
      select: { id: true },
    });
    if (existing) {
      return { summaryId: existing.id, notes: [], embedded: false };
    }

    const messages = await this.prisma.conversationMessage.findMany({
      where: { conversationId: input.conversationId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const charLimit = this.aiConfig.context.characterLimit;
    let used = 0;
    const transcript: string[] = [];
    for (const m of messages) {
      if (used + m.content.length > charLimit) break;
      transcript.push(`${m.role === 'USER' ? 'Student' : 'Soul Nurture'}: ${m.content}`);
      used += m.content.length;
    }

    const systemPrompt = [
      SUMMARY_SYSTEM_PROMPT,
      `Prompt version: ${SUMMARY_PROMPT_VERSION}`,
      `Canonical topics: ${CANONICAL_TOPICS.join(', ')}`,
      `Transcript:\n${transcript.join('\n')}`,
    ].join('\n\n');

    const raw: unknown = await this.provider.generateResponse({
      systemPrompt,
      messages: [],
      jsonSchema: SUMMARY_JSON_SCHEMA,
    });

    // Throws AiGenerationError on invalid output — the worker's retry
    // schedule treats it like any other generation failure.
    const parsed = validateSessionSummary(raw);

    const notes: string[] = [];
    const filteredSummary = filterSummaryText(parsed.summary);
    notes.push(...filteredSummary.notes);
    const summary = filteredSummary.text ?? SUMMARY_FALLBACK;
    if (!filteredSummary.text) {
      notes.push('Summary guard dropped every sentence; fallback copy used.');
    }

    let followUpHook = parsed.followUpHook;
    if (followUpHook) {
      const filteredHook = filterSummaryText(followUpHook);
      notes.push(...filteredHook.notes);
      followUpHook = filteredHook.text;
    }

    const row = await this.prisma.sessionSummary.create({
      data: {
        studentId: input.studentId,
        conversationId: input.conversationId,
        summary,
        topics: parsed.topics,
        followUpHook,
        emotionalTrend: parsed.emotionalTrend,
      },
    });

    const embedded = await this.memory.embedAndStore(
      row.id,
      `${row.summary} ${row.topics.join(' ')}`,
    );

    return { summaryId: row.id, notes, embedded };
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
