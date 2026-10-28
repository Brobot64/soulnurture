import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageRole, Prisma, SupportFlagSeverity } from '@prisma/client';
import { AiService } from '../ai/ai.service.js';
import type { AiOrchestrationInput } from '../ai/ai.service.js';
import type { AiOrchestrationOutcome } from '../ai/ai.service.js';
import { IntentEngineService } from '../ai/intents/intent-engine.service.js';
import { GuardrailService } from '../ai/guardrails/guardrail.service.js';
import { applyIntentVerdict } from '../ai/intents/intent-executors.js';
import { LanguageDetectorService } from '../ai/language/language-detector.service.js';
import type { SupportedLanguage } from '../ai/language/language.config.js';
import { resolveTurnLanguage } from '../ai/language/turn-language.js';
import { holdingLine } from '../ai/language/scripted-copy.js';
import { AI_CONFIG } from '../ai/config/ai.config.js';
import type { AiConfig } from '../ai/config/ai.config.js';
import type { AiGenerationResult } from '../ai/providers/ai-provider.interface.js';
import type { AiContext } from '../ai/context/ai-context.service.js';
import { AiGenerationError } from '../ai/ai.errors.js';
import { AI_DISCLOSURE_CONSENT_VERSION } from '../ai/disclosure/ai-disclosure.js';
import { AuditService } from '../audit/audit.service.js';
import { ConsentRequiredException } from '../consent/consent.errors.js';
import { ConsentService } from '../consent/consent.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { REALTIME_EVENTS } from '../realtime/realtime.events.js';
import { inSchool } from '../common/tenant/school-scope.js';
import { REVIEWER_ROLES } from '../common/guards/roles.decorator.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import { SupportFlagAlertsService } from '../support-flags/support-flag-alerts.service.js';
import type { CreateConversationDto } from './dto/create-conversation.dto.js';
import type { SendMessageDto } from './dto/send-message.dto.js';

type LaneOutcome = AiOrchestrationOutcome & { asyncQueued: boolean };

function holdingResult(holdingMessage: string): AiGenerationResult {
  return {
    message: holdingMessage,
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'NONE',
  };
}

function emptyContext(): AiContext {
  return {
    student: { firstName: null, preferredLanguage: null },
    currentCheckIn: null,
    recentConversation: [],
    relevantReflection: null,
    relevantResources: [],
    currentJourneyStep: null,
    carriedContext: null,
  };
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    private readonly intentEngine: IntentEngineService,
    private readonly guardrail: GuardrailService,
    private readonly languageDetector: LanguageDetectorService,
    private readonly flagAlerts: SupportFlagAlertsService,
    private readonly auditService: AuditService,
    private readonly consentService: ConsentService,
    private readonly realtime: RealtimeService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  /**
   * AI consent gate. Enforced here, not only in the client modal: opening the
   * chat is never consent, so no AI conversation may be created or continued
   * without an accepted ConsentRecord for the CURRENT disclosure version.
   * Bumping the version re-prompts every student once.
   */
  private async assertDisclosureAccepted(studentId: string) {
    const accepted = await this.consentService.hasAcceptedForStudent(
      studentId,
      AI_DISCLOSURE_CONSENT_VERSION,
    );
    if (!accepted) throw new ConsentRequiredException();
  }

  private async owned(userId: string, conversationId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId, user: { role: 'STUDENT' } },
    });
    if (!student) throw new NotFoundException('Conversation not found');
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId, studentId: student.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return { student, conversation };
  }

  async create(userId: string, dto: CreateConversationDto) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId, user: { role: 'STUDENT' } },
    });
    if (!student) throw new ConsentRequiredException();
    await this.assertDisclosureAccepted(student.id);
    if (dto.checkInId) {
      const checkIn = await this.prisma.emotionalCheckIn.findUnique({
        where: { id: dto.checkInId, studentId: student.id },
        select: { id: true },
      });
      if (!checkIn) throw new NotFoundException('Check-in not found');
    }
    return this.prisma.conversation.create({
      data: {
        studentId: student.id,
        checkInId: dto.checkInId,
        source: dto.source,
      },
    });
  }

  async listMine(userId: string) {
    const items = await this.prisma.conversation.findMany({
      where: { student: { userId, user: { role: 'STUDENT' } } },
      orderBy: { updatedAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, schoolId: true },
    });
    if (user && STAFF_ROLES.some((role) => role === user.role)) {
      if (!user.schoolId) throw new NotFoundException('Conversation not found');
      const conversation = await this.prisma.conversation.findFirst({
        where: { id, ...inSchool(user.schoolId) },
        include: {
          messages: { orderBy: { createdAt: 'asc' } },
          student: { select: { user: { select: { schoolId: true } } } },
        },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
      return conversation;
    }
    if (user?.role !== 'STUDENT') throw new ForbiddenException();
    const { conversation } = await this.owned(userId, id);
    return conversation;
  }

  async getReviewContext(userId: string, id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, schoolId: true },
    });
    if (!user || !REVIEWER_ROLES.some((role) => role === user.role)) {
      throw new ForbiddenException();
    }
    if (!user.schoolId) throw new NotFoundException('Conversation not found');
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, ...inSchool(user.schoolId) },
      select: {
        id: true,
        status: true,
        language: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { role: { in: [MessageRole.USER, MessageRole.ASSISTANT] } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, role: true, content: true, language: true, createdAt: true },
        },
        summary: {
          select: {
            id: true,
            summary: true,
            topics: true,
            followUpHook: true,
            emotionalTrend: true,
            summaryLocalized: true,
            followUpHookLocalized: true,
            createdAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /**
   * Student closes a conversation. Idempotent: an already CLOSED/ARCHIVED
   * conversation returns without enqueueing anything. When the conversation
   * has messages and no summary yet, a SUMMARY AiGenerationJob is queued —
   * the AI worker writes the session summary that feeds memory recall.
   */
  async close(userId: string, id: string) {
    const { student, conversation } = await this.owned(userId, id);
    if (conversation.status !== 'ACTIVE') {
      return { conversation, summaryQueued: false };
    }

    const closed = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: 'CLOSED' },
    });

    let summaryQueued = false;
    const existingSummary = await this.prisma.sessionSummary.findUnique({
      where: { conversationId: conversation.id },
      select: { id: true },
    });
    if (conversation.messages.length > 0 && !existingSummary) {
      await this.prisma.aiGenerationJob.create({
        data: {
          kind: 'SUMMARY',
          conversationMessageId: null,
          input: {
            studentId: student.id,
            conversationId: conversation.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      summaryQueued = true;
    }

    await this.auditService.log({
      actorId: userId,
      action: 'conversation.closed',
      entity: 'Conversation',
      entityId: conversation.id,
      meta: { summaryQueued },
    });

    // Push after the write, so any device still open on this check-in sees a
    // closed conversation rather than one it can still type into.
    this.realtime.emitToUser(userId, REALTIME_EVENTS.CONVERSATION_CLOSED, {
      conversationId: conversation.id,
      checkInId: conversation.checkInId,
      reason: 'MANUAL',
    });

    return { conversation: closed, summaryQueued };
  }

  async sendMessage(userId: string, id: string, dto: SendMessageDto) {
    const { student, conversation } = await this.owned(userId, id);

    // AI consent gate — checked before the rate gate and before any write, so
    // a student who has not accepted the current explanation leaves no trace.
    await this.assertDisclosureAccepted(student.id);

    // Closed conversations are read-only (history sidebar opens them for
    // viewing). Reject before any write or rate-gate consumption.
    if (conversation.status !== 'ACTIVE') {
      throw new ConflictException(
        'This conversation is closed. Start a new check-in to keep talking.',
      );
    }

    // Rate gate — runs before any DB write so a rejected turn leaves no trace
    // and consumes no budget. Guards AI chat turns only; the human support
    // route (support-requests) never passes through here.
    this.guardrail.assertMessageAllowed(student.id);

    // Realtime language detection (offline heuristics; N-ATLaS only when
    // every heuristic is silent — fail-open, short timeout). The detected
    // language drives THIS turn's reply, 'en' included (whoever types English
    // can read it; the preference only fills silence) — the client passes no
    // language, detection from the message content is the sole input.
    // Detection also drives the one-time language offer and the async
    // VERNACULAR job (vernacular codes only).
    const detection = await this.languageDetector.detect(dto.content);
    const detectedLanguage =
      detection.lang !== null && detection.lang !== 'en' ? detection.lang : null;
    const languageOffer =
      detectedLanguage &&
      this.aiConfig.language.offerEnabled &&
      student.preferredLanguage === 'en'
        ? { detected: detectedLanguage, current: student.preferredLanguage }
        : null;

    // Per-turn reply language: this message's detection, else the language
    // this conversation is already using, else the preference. A confident
    // detection becomes the conversation's language, so later silent messages
    // ("ok", short unmarked text) keep replying in it.
    const turnLanguage = resolveTurnLanguage({
      detected: detection.lang,
      conversationLanguage: conversation.language,
      preferredLanguage: student.preferredLanguage,
    });
    // Low-confidence reads (code-switched text) reply in their language for
    // this turn only; they never change the conversation's language.
    const confident = detection.confidence !== 'low';
    if (
      confident &&
      detection.lang !== null &&
      detection.lang !== conversation.language
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { language: detection.lang },
      });
    }

    const userMessage = await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: dto.content,
        quickReply: dto.quickReply ?? null,
        viaVoice: dto.viaVoice ?? false,
        language: turnLanguage,
      },
    });

    const orchestrationInput = {
      studentId: student.id,
      conversationId: conversation.id,
      checkInId: conversation.checkInId,
      userContent: dto.content,
      messageLanguage: turnLanguage,
      currentMessageId: userMessage.id,
      studentRef: student.displayName ?? student.firstName ?? 'Student',
      classLabel: student.classLabel ?? null,
      quickReply: dto.quickReply ?? null,
    } as const;

    // Full orchestration on the happy path; on provider failure the student
    // still gets an instant reply — and the intent engine runs server-side
    // regardless, so safeguarding flags + human-support guidance exist even
    // while the AI is down. The real reply lands later via the DB queue.
    let outcome: LaneOutcome;
    try {
      outcome = { ...await this.aiService.generateAndApply(orchestrationInput), asyncQueued: false };
    } catch (error) {
      if (!(error instanceof AiGenerationError)) throw error;
      outcome = await this.holdAndQueue(orchestrationInput);
    }

    const aiResult = outcome.result;
    const assistantMessage = await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        content: aiResult.message,
        // The language this reply is actually written in (a render may have
        // moved it off the turn language, e.g. a scripted line).
        language: aiResult.render?.language ?? turnLanguage,
        aiPayload: {
          ...aiResult,
          applicationNotes: outcome.notes,
        } as unknown as Prisma.InputJsonValue,
        activeExerciseLabel:
          aiResult.exerciseLabel ??
          (aiResult.action === 'GROUNDING'
            ? 'ACT Grounding Exercise active'
            : null),
      },
    });

    if (outcome.asyncQueued) {
      await this.prisma.aiGenerationJob.create({
        data: {
          conversationMessageId: assistantMessage.id,
          nextRetryAt: new Date(
            Date.now() + this.aiConfig.async.retryDelaysMs[0],
          ),
          input: orchestrationInput as unknown as Prisma.InputJsonValue,
        },
      });
      await this.auditService.log({
        actorId: userId,
        action: 'ai_generation.queued',
        entity: 'Conversation',
        entityId: conversation.id,
        meta: { conversationMessageId: assistantMessage.id },
      });
    }

    // Vernacular message: queue the async understanding lane (translate →
    // store understanding → second intent sweep on the English translation).
    // Queued after the outcome so the job knows whether the first pass
    // already flagged (skips the second sweep when it did).
    // Every non-English turn gets the translation sweep: a confident detection,
    // or — for a silent message — the language the conversation is using. A
    // silent message is not a skipped safety check.
    const understandingLanguage: SupportedLanguage | null =
      detectedLanguage ?? (turnLanguage !== 'en' ? turnLanguage : null);
    if (understandingLanguage) {
      await this.prisma.aiGenerationJob.create({
        data: {
          kind: 'VERNACULAR',
          conversationMessageId: userMessage.id,
          input: {
            studentId: student.id,
            conversationId: conversation.id,
            studentRef: orchestrationInput.studentRef,
            classLabel: orchestrationInput.classLabel,
            language: understandingLanguage,
            firstPassFlagged: Boolean(outcome.verdict),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.auditService.log({
        actorId: userId,
        action: 'ai_understanding.queued',
        entity: 'ConversationMessage',
        entityId: userMessage.id,
        meta: {
          conversationId: conversation.id,
          language: understandingLanguage,
          detectedBy: detection.method,
          confidence: detection.confidence,
          firstPassFlagged: Boolean(outcome.verdict),
        },
      });
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    const recommendedResource =
      aiResult.resource.recommended && aiResult.resource.resourceId
        ? {
            id: aiResult.resource.resourceId,
            title:
              outcome.context.relevantResources.find(
                (r) => r.id === aiResult.resource.resourceId,
              )?.title ?? null,
            type: null,
          }
        : null;

    const recommendedActivity =
      aiResult.activity?.recommended && aiResult.activity.slug
        ? { slug: aiResult.activity.slug, title: aiResult.activity.title ?? null }
        : null;

    return {
      userMessage,
      assistantMessage,
      humanCareRecommendation: aiResult.humanSupport.recommended
        ? {
            show: true,
            message: aiResult.humanSupport.reason,
            professionalName: null,
            professionalId: null,
          }
        : null,
      recommendedResource,
      recommendedActivity,
      activeIntent: outcome.verdict
        ? {
            id: outcome.verdict.intentId,
            label: outcome.verdict.intentLabel,
            severity: outcome.verdict.severity,
            matchedBy: outcome.verdict.matchedBy,
          }
        : null,
      aiPending: aiResult.asyncState === 'PENDING_AI',
      languageOffer,
    };
  }

  /**
   * Instant holding lane: empathetic reply immediately; the real generation
   * is queued (AiGenerationJob) and the AI worker updates the message in
   * place later — including after the student has closed the window.
   * Intent evaluation still runs here (server keyword layer works even when
   * the model is down) so acute flags are never delayed.
   */
  private async holdAndQueue(
    input: AiOrchestrationInput,
  ): Promise<LaneOutcome> {
    // Holding reply and any acute copy follow the turn's language — the
    // degraded lane must not answer a Hausa student in English.
    const language: SupportedLanguage = input.messageLanguage ?? 'en';
    const placeholder = holdingResult(
      holdingLine(language, this.aiConfig.async.holdingMessage),
    );
    const verdict = this.intentEngine.evaluate({
      userContent: input.userContent,
      aiResult: placeholder,
    });

    let notes: string[] = [];
    if (verdict) {
      // The turn language already resolved this message's language (or the
      // conversation's), so the degraded lane does not re-run detection.
      const alertLanguage: SupportedLanguage | undefined =
        input.messageLanguage ?? undefined;
      notes = await applyIntentVerdict(verdict, {
        prisma: this.prisma,
        auditService: this.auditService,
        result: placeholder,
        studentId: input.studentId,
        studentRef: input.studentRef,
        classLabel: input.classLabel,
        conversationId: input.conversationId,
        userContent: input.userContent,
        relevantResources: emptyContext().relevantResources,
        flagAlerts: this.flagAlerts,
        alertLanguage,
        replyLanguage: language,
      });
    }

    placeholder.asyncState = 'PENDING_AI';
    // The real reply is still queued, but an acute referral must not wait for
    // the model: the student sees the not-an-emergency-service notice now.
    if (verdict?.severity === SupportFlagSeverity.TIER_3_ACUTE) {
      placeholder.boundary = {
        kind: 'ACUTE_SAFEGUARD_ROUTE',
        intentId: verdict.intentId,
      };
    }
    return {
      result: placeholder,
      context: emptyContext(),
      verdict,
      notes: [
        ...notes,
        'AI generation unavailable; the real response is queued for retry.',
      ],
      asyncQueued: true,
    };
  }
}
