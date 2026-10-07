import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { NatlasTranslationProvider } from './providers/natlas/natlas.provider.js';
import type { MessageUnderstanding } from './language/understanding.schema.js';
import {
  ASR_VERNACULAR_LANGUAGES,
  languagePromptDirective,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './language/language.config.js';
import { NAtlasAsrProvider } from './providers/natlas/natlas-asr.provider.js';

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

export interface UnderstandMessageInput {
  studentId: string;
  conversationId: string;
  /** The USER message the understanding is attached to. */
  messageId: string;
  content: string;
  language: SupportedLanguage;
  studentRef: string;
  classLabel: string | null;
  /** The synchronous first pass already flagged — skip the second sweep. */
  firstPassFlagged: boolean;
}

export interface UnderstandMessageOutcome {
  understanding: MessageUnderstanding;
  /** True when the English translation tripped the server keyword floor. */
  escalated: boolean;
  notes: string[];
}

/** The subset of UnderstandMessageInput carried in the VERNACULAR job row;
 * the worker fills messageId/content from the referenced message. */
export type VernacularJobInput = Omit<
  UnderstandMessageInput,
  'messageId' | 'content'
>;

const SUMMARY_FALLBACK =
  'The student talked with Soul Nurture about their wellbeing.';

/** Second-pass placeholder: a model that flagged nothing — only the server
 * keyword layer can fire on the translated text. */
function noFlagResult(): AiGenerationResult {
  return {
    message: '',
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'NONE',
  };
}

/** USER messages sent in a Nigerian language summarize from their English
 * understanding (when the VERNACULAR lane produced one) so the summary model
 * reads meaning, not untranslated content. */
function transcriptText(m: {
  role: string;
  content: string;
  aiPayload: unknown;
}): string {
  if (m.role !== 'USER') return m.content;
  const payload =
    m.aiPayload && typeof m.aiPayload === 'object'
      ? (m.aiPayload as Record<string, unknown>)
      : null;
  const understanding =
    payload?.understanding && typeof payload.understanding === 'object'
      ? (payload.understanding as Record<string, unknown>)
      : null;
  const translation = understanding?.englishTranslation;
  return typeof translation === 'string' && translation.length > 0
    ? translation
    : m.content;
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
    private readonly memory: MemoryRepository,
    private readonly understandingProvider: NatlasTranslationProvider,
    private readonly natlasAsr: NAtlasAsrProvider,
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
      languagePromptDirective(
        input.language ?? ctx.student.preferredLanguage ?? 'en',
      ),
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
      select: { role: true, content: true, aiPayload: true },
    });
    const charLimit = this.aiConfig.context.characterLimit;
    let used = 0;
    const transcript: string[] = [];
    for (const m of messages) {
      const text = transcriptText(m);
      if (used + text.length > charLimit) break;
      transcript.push(`${m.role === 'USER' ? 'Student' : 'Soul Nurture'}: ${text}`);
      used += text.length;
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

  /**
   * Vernacular understanding (Phase C step 4). The worker's VERNACULAR lane
   * calls this for every non-English USER message: the translation lane
   * (local N-ATLaS → OpenAI fallback) produces a strict understanding, which
   * is merged onto the message's aiPayload. When the synchronous first pass
   * did not flag, the intent engine re-runs on the ENGLISH TRANSLATION as a
   * second safety sweep — a crisis phrase invisible to the keyword floor in
   * its original language becomes an AI_CANDIDATE flag (audit
   * safety_flag.lang_refine).
   */
  async understandMessage(
    input: UnderstandMessageInput,
  ): Promise<UnderstandMessageOutcome> {
    const { understanding } = await this.understandingProvider.understand({
      text: input.content,
      language: input.language,
    });
    const notes: string[] = [
      `Understood ${input.language} message via ${understanding.via} (tone ${understanding.tone}).`,
    ];

    // Merge — never clobber — the synchronous payload the holding lane wrote.
    const message = await this.prisma.conversationMessage.findUnique({
      where: { id: input.messageId },
      select: { aiPayload: true },
    });
    const payload =
      message?.aiPayload && typeof message.aiPayload === 'object'
        ? (message.aiPayload as Record<string, unknown>)
        : {};
    await this.prisma.conversationMessage.update({
      where: { id: input.messageId },
      data: {
        aiPayload: { ...payload, understanding } as unknown as Prisma.InputJsonValue,
      },
    });

    let escalated = false;
    if (!input.firstPassFlagged) {
      const secondPass = noFlagResult();
      const verdict = this.intentEngine.evaluate({
        userContent: understanding.englishTranslation,
        aiResult: secondPass,
      });
      if (verdict) {
        notes.push(
          ...(await applyIntentVerdict(verdict, {
            prisma: this.prisma,
            auditService: this.auditService,
            result: secondPass,
            studentId: input.studentId,
            studentRef: input.studentRef,
            classLabel: input.classLabel,
            conversationId: input.conversationId,
            userContent: understanding.englishTranslation,
            relevantResources: [],
            flagSourceOverride: 'AI_CANDIDATE',
          })),
        );
        escalated = true;
        await this.auditService.log({
          action: 'safety_flag.lang_refine',
          entity: 'ConversationMessage',
          entityId: input.messageId,
          meta: {
            conversationId: input.conversationId,
            language: input.language,
            via: understanding.via,
            intentId: verdict.intentId,
            severity: verdict.severity,
          },
        });
        notes.push(
          `Second-pass escalation: ${verdict.intentId ?? verdict.intentLabel} matched on the English translation.`,
        );
      }
    }

    return { understanding, escalated, notes };
  }

  /**
   * Voice routing (Phase C step 5):
   *   yo / ha / ig  → local N-ATLaS ASR sidecar (NCAIR1 checkpoints)
   *   en / pcm      → provider chain (Groq Whisper). Pidgin is lexified on
   *                   English and Whisper auto-detects it; no hint is sent
   *                   for pcm because Whisper has no pcm language code.
   * A client-supplied `language` (validated) overrides the student profile.
   */
  async transcribe(file: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    language?: string;
    preferredLanguage?: string;
  }): Promise<AiTranscriptionResult> {
    const requested = file.language?.trim().toLowerCase() || undefined;
    if (
      requested &&
      !SUPPORTED_LANGUAGES.includes(requested as SupportedLanguage)
    ) {
      throw new BadRequestException(`Unsupported language: ${file.language}`);
    }

    const language = requested ?? file.preferredLanguage ?? 'en';
    const audio = {
      buffer: file.buffer,
      filename: file.filename,
      mimeType: file.mimeType,
    };

    if ((ASR_VERNACULAR_LANGUAGES as readonly string[]).includes(language)) {
      return this.natlasAsr.transcribeAudio({ ...audio, language });
    }

    return this.provider.transcribeAudio({
      ...audio,
      language: language === 'en' ? 'en' : undefined,
    });
  }
}
