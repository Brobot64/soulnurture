import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma, SupportFlagSeverity } from '@prisma/client';
import { AiContextService } from './context/ai-context.service.js';
import { GuardrailService } from './guardrails/guardrail.service.js';
import {
  SYSTEM_PROMPT,
  REFLECTION_PROMPT_VERSION,
} from './prompts/system.prompt.js';
import { IntentEngineService } from './intents/intent-engine.service.js';
import { SupportFlagAlertsService } from '../support-flags/support-flag-alerts.service.js';
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
import {
  HANDOFF_ENTRY_JSON_SCHEMA,
  validateHandoffEntry,
} from './chat/handoff-entry.schema.js';
import {
  HANDOFF_ENTRY_SYSTEM_PROMPT,
  HANDOFF_ENTRY_PROMPT_VERSION,
} from './chat/handoff.prompt.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { QuickReplyValue } from '../conversations/dto/send-message.dto.js';
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
  LANGUAGE_DISPLAY_NAMES,
  languagePromptDirective,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './language/language.config.js';
import { interimEnglishDirective } from './language/render.prompt.js';
import { pivotTurnText } from './language/history-pivot.js';
import { genericReplyLine } from './language/scripted-copy.js';
import { ReplyRendererService } from './language/reply-renderer.service.js';
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
  /** Language detected in THIS message's text (synchronous detector in the
   * conversations lane; N-ATLaS classifies when heuristics are silent). The
   * reply follows the message — 'en' included — so whoever types English
   * gets English and whoever types Yoruba/Hausa/Igbo gets theirs, turn by
   * turn; the client never passes a language. Null falls back to the
   * student's standing preference, then English. */
  messageLanguage?: SupportedLanguage | null;
  /** The saved student message this turn answers; excluded from history so it
   * appears once, as the current turn. */
  currentMessageId?: string | null;
  studentRef: string;
  classLabel: string | null;
  /** Guided-reply marker from the DTO; drives the directive selection. */
  quickReply?: QuickReplyValue | null;
  /** Free-text USER turns so far in this conversation. */
  freeTextTurns?: number;
  /** Free-text turn budget (base or extended). */
  turnBudget?: number;
  /** True when freeTextTurns reached the budget OR total turns (free text +
   * quick replies) hit the maxExtendedTurns cap — wrap-up directive applies. */
  finalTurn?: boolean;
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

export interface ComposeHandoffEntryInput {
  firstName: string;
  classLabel: string | null;
  feelingLabel: string | null;
  intensity: string | null;
  triggers: string[];
  /** The student's optional note attached to the chat request. */
  note: string | null;
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
    private readonly replyRenderer: ReplyRendererService,
    private readonly flagAlerts: SupportFlagAlertsService,
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
      excludeMessageId: input.currentMessageId ?? null,
    });

    // Guided-mode directives. An OPEN support flag on the conversation
    // REPLACES every guided line — safeguarding outranks the guided
    // experience. Guardrails, the intent floor and the resource whitelist
    // below are untouched: this only shapes the reply, never the safety net.
    const openFlag = await this.prisma.supportFlag.findFirst({
      where: { conversationId: input.conversationId, status: 'OPEN' },
      select: { id: true },
    });
    const guidedLines: string[] = [];
    if (openFlag) {
      guidedLines.push(this.aiConfig.guided.flagDirective);
    } else {
      // On the final turn the TELL_MORE directive is skipped — its "invite
      // them to share / ask one gentle question" would contradict the
      // wrap-up. SHOW_IDEA / TALK_TO_SOMEONE still apply: their reply can
      // deliver the idea or hand-off while closing warmly.
      if (
        input.quickReply &&
        !(input.finalTurn && input.quickReply === this.aiConfig.guided.extension)
      ) {
        const directive = this.aiConfig.guided.directives[input.quickReply];
        if (directive) guidedLines.push(directive);
      }
      if (input.turnBudget != null && input.freeTextTurns != null) {
        guidedLines.push(
          `Guided check-in budget: ${input.freeTextTurns}/${input.turnBudget} free-text turns used` +
            (input.finalTurn ? ' — this is the final turn.' : '.'),
        );
      }
      if (input.finalTurn) {
        guidedLines.push(this.aiConfig.guided.wrapUpDirective);
      }
    }

    // Reply language for this turn: the language detected in THIS message's
    // text (per-message following — 'en' included; the preference only fills
    // in when detection found nothing). With the n-atlas-translate mode a
    // non-English turn also flips the generation directive to interim English
    // — the finished reply is rendered afterwards by the local model.
    const replyLanguage = this.resolveReplyLanguage(
      input,
      ctx.student.preferredLanguage,
    );
    const renderActive =
      this.aiConfig.language.vernacularReplyMode === 'n-atlas-translate' &&
      replyLanguage !== 'en';

    // Input guardrail: the model sees the truncated message; the intent floor
    // below still evaluates the RAW userContent — safety is never truncated.
    const sanitized = this.guardrail.sanitizeInput(input.userContent);

    // Translate, then draft. In the English-draft mode a non-English message is
    // translated by N-ATLaS first, and OpenAI drafts the reply from that English
    // — not from the raw text. The raw text still goes to the intent engine
    // below, so keyword safety never depends on the translation.
    const translationNotes: string[] = [];
    let draftSource = sanitized.content;
    if (renderActive) {
      try {
        const { understanding } = await this.understandingProvider.understand({
          text: input.userContent,
          language: replyLanguage,
        });
        draftSource = this.guardrail.sanitizeInput(
          understanding.englishTranslation,
        ).content;
        translationNotes.push(
          `Drafted from the English translation (via ${understanding.via}).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        translationNotes.push(
          `Translation unavailable; drafted from the original message (${message}).`,
        );
      }
    }

    const systemPrompt = [
      SYSTEM_PROMPT,
      `Prompt version: ${REFLECTION_PROMPT_VERSION}`,
      renderActive
        ? interimEnglishDirective(replyLanguage)
        : languagePromptDirective(replyLanguage),
      ...guidedLines,
      `Valid supportFlag.category values: ${CANONICAL_CATEGORIES.join(', ')}`,
      `Valid supportFlag.severity values: ${CANONICAL_SEVERITIES.join(', ')}`,
      // History travels once, as the messages array below — not twice.
      `Approved context JSON: ${JSON.stringify({ ...ctx, recentConversation: undefined })}`,
      ...(sanitized.injected
        ? [this.guardrail.promptHardeningLine()]
        : []),
    ].join('\n\n');

    const messages = [
      ...ctx.recentConversation.map((m) => ({
        role: (m.role === 'USER' ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        // Non-English turns are tagged so the model can see the language each
        // turn was in; English is the default and stays untagged.
        content:
          m.language && m.language !== 'en'
            ? `[${LANGUAGE_DISPLAY_NAMES[m.language as SupportedLanguage] ?? m.language}] ${m.content}`
            : m.content,
      })),
      { role: 'user' as const, content: draftSource },
    ];

    let raw: unknown;
    try {
      raw = await this.provider.generateResponse({
        systemPrompt,
        messages,
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

    const notes: string[] = [
      ...sanitized.notes,
      ...translationNotes,
      ...filtered.notes,
    ];
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
          flagAlerts: this.flagAlerts,
          alertLanguage: replyLanguage,
          replyLanguage,
        })),
      );
    }

    // Server-owned record of why this turn left the AI's remit. An acute
    // safeguarding referral is the louder truth of the two, so it wins when a
    // turn both overstepped the banned-claim floor and hit the acute keywords.
    if (verdict?.severity === SupportFlagSeverity.TIER_3_ACUTE) {
      result.boundary = { kind: 'ACUTE_SAFEGUARD_ROUTE', intentId: verdict.intentId };
    } else if (filtered.outOfScope) {
      result.boundary = { kind: 'OUT_OF_SCOPE', intentId: null };
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
    result.boundary ??= null;

    // Render lane (n-atlas-translate): the finished English reply is rendered
    // into the turn's language within this same request (enhancement on the
    // happy path, never a blocker).
    //
    // Acute copy is NOT live-translated: a SAFETY_MESSAGE verdict already put
    // the pre-approved in-language line on the result (intent-executors), so
    // the crisis line never depends on a translator being up. If every render
    // lane fails, the student still gets a scripted line in their language —
    // never the English reply.
    const safetyAction = verdict?.actions.find((a) => a.type === 'SAFETY_MESSAGE');
    if (renderActive && safetyAction?.type === 'SAFETY_MESSAGE') {
      result.render = {
        language: replyLanguage,
        via: 'scripted',
        englishSource: safetyAction.message,
      };
      notes.push(
        `Scripted ${LANGUAGE_DISPLAY_NAMES[replyLanguage]} safety copy applied; no live translation.`,
      );
    } else if (renderActive) {
      const englishReply = result.message;
      const rendered = await this.replyRenderer.render({
        englishReply,
        language: replyLanguage,
        contextLines: [
          `Student: ${input.studentRef}${input.classLabel ? ` (${input.classLabel})` : ''}`,
          `The student just wrote: ${input.userContent}`,
        ],
      });
      if (rendered) {
        result.render = {
          language: replyLanguage,
          via: rendered.via,
          englishSource: englishReply,
        };
        result.message = rendered.rendered;
        notes.push(
          `Reply rendered in ${LANGUAGE_DISPLAY_NAMES[replyLanguage]} via ${rendered.via}.`,
        );
      } else {
        result.message = genericReplyLine(replyLanguage);
        result.render = {
          language: replyLanguage,
          via: 'scripted',
          englishSource: englishReply,
        };
        notes.push(
          `Reply render unavailable; sent the scripted ${LANGUAGE_DISPLAY_NAMES[replyLanguage]} reply.`,
        );
      }
    }

    return { result, context: ctx, verdict, notes };
  }

  /** Per-turn reply language, strict priority: the language detected in
   * THIS message's text (any supported code — 'en' included, whoever types
   * English can read it), then the student's standing preference, then
   * English. Detection is authoritative because it follows the input; the
   * client passes no language, so the preference only ever fills in when
   * detection found nothing. */
  private resolveReplyLanguage(
    input: AiOrchestrationInput,
    preferredLanguage: string | null | undefined,
  ): SupportedLanguage {
    const candidates = [input.messageLanguage, preferredLanguage];
    for (const code of candidates) {
      if (code && SUPPORTED_LANGUAGES.includes(code as SupportedLanguage)) {
        return code as SupportedLanguage;
      }
    }
    return 'en';
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
      const text = pivotTurnText(m);
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
   * Chat hand-off composer (Phase 6). Produces the professional-facing entry
   * note for a human-chat request: who the student is, how their latest
   * check-in read, and the gist of their note — never verbatim sensitive or
   * crisis wording. Output passes the same low-sensitivity summary guard as
   * session summaries; when the guard leaves nothing, this throws so the
   * caller falls back to deterministic copy (thread creation must never
   * depend on AI being available).
   */
  async composeHandoffEntry(
    input: ComposeHandoffEntryInput,
  ): Promise<string> {
    const contextLines = [
      `Student first name: ${input.firstName}`,
      input.classLabel ? `Class: ${input.classLabel}` : null,
      input.feelingLabel
        ? `Latest check-in: feeling ${input.feelingLabel}, intensity ${input.intensity ?? 'unspecified'}`
        : 'No emotional check-in recorded.',
      input.triggers.length > 0
        ? `Topics they mentioned: ${input.triggers.join(', ')}`
        : null,
      input.note ? `Student's note: ${input.note}` : null,
    ].filter((line): line is string => line !== null);

    const systemPrompt = [
      HANDOFF_ENTRY_SYSTEM_PROMPT,
      `Prompt version: ${HANDOFF_ENTRY_PROMPT_VERSION}`,
    ].join('\n\n');

    const raw: unknown = await this.provider.generateResponse({
      systemPrompt,
      messages: [{ role: 'user', content: contextLines.join('\n') }],
      jsonSchema: HANDOFF_ENTRY_JSON_SCHEMA,
    });

    const parsed = validateHandoffEntry(raw);
    const filtered = filterSummaryText(parsed.message);
    if (!filtered.text) {
      throw new AiGenerationError(
        'Summary guard dropped every handoff sentence',
      );
    }
    return filtered.text;
  }

  /**
   * Vernacular understanding (Phase C step 4). The worker's VERNACULAR lane
   * calls this for every non-English USER message: the translation lane
   * (N-ATLaS only) produces a strict understanding, which
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
            flagAlerts: this.flagAlerts,
            alertLanguage: input.language,
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
