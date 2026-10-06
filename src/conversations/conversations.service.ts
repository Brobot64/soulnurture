import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageRole, Prisma } from '@prisma/client';
import { AiService } from '../ai/ai.service.js';
import type { AiOrchestrationOutcome } from '../ai/ai.service.js';
import { IntentEngineService } from '../ai/intents/intent-engine.service.js';
import { GuardrailService } from '../ai/guardrails/guardrail.service.js';
import { applyIntentVerdict } from '../ai/intents/intent-executors.js';
import { AI_CONFIG } from '../ai/config/ai.config.js';
import type { AiConfig } from '../ai/config/ai.config.js';
import type { AiGenerationResult } from '../ai/providers/ai-provider.interface.js';
import type { AiContext } from '../ai/context/ai-context.service.js';
import { AiGenerationError } from '../ai/ai.errors.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
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
  };
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly aiService: AiService,
    private readonly intentEngine: IntentEngineService,
    private readonly guardrail: GuardrailService,
    private readonly auditService: AuditService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private async owned(userId: string, conversationId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.studentId !== student.id) throw new ForbiddenException();
    return { student, conversation };
  }

  async create(userId: string, dto: CreateConversationDto) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.conversation.create({
      data: {
        studentId: student.id,
        checkInId: dto.checkInId,
        source: dto.source,
      },
    });
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.conversation.findMany({
      where: { studentId: student.id },
      orderBy: { updatedAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const { conversation } = await this.owned(userId, id);
    return conversation;
  }

  async sendMessage(userId: string, id: string, dto: SendMessageDto) {
    const { student, conversation } = await this.owned(userId, id);

    // Rate gate — runs before any DB write so a rejected turn leaves no trace
    // and consumes no budget. Guards AI chat turns only; the human support
    // route (support-requests) never passes through here.
    this.guardrail.assertMessageAllowed(student.id);

    const userMessage = await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.USER,
        content: dto.content,
      },
    });

    const orchestrationInput = {
      studentId: student.id,
      conversationId: conversation.id,
      checkInId: conversation.checkInId,
      userContent: dto.content,
      language: dto.language ?? student.preferredLanguage,
      studentRef: student.displayName ?? student.firstName ?? 'Student',
      classLabel: student.classLabel ?? null,
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
      activeIntent: outcome.verdict
        ? {
            id: outcome.verdict.intentId,
            label: outcome.verdict.intentLabel,
            severity: outcome.verdict.severity,
            matchedBy: outcome.verdict.matchedBy,
          }
        : null,
      aiPending: aiResult.asyncState === 'PENDING_AI',
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
    input: {
      studentId: string;
      conversationId: string;
      checkInId?: string | null;
      userContent: string;
      language?: string;
      studentRef: string;
      classLabel: string | null;
    },
  ): Promise<LaneOutcome> {
    const placeholder = holdingResult(this.aiConfig.async.holdingMessage);
    const verdict = this.intentEngine.evaluate({
      userContent: input.userContent,
      aiResult: placeholder,
    });

    let notes: string[] = [];
    if (verdict) {
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
      });
    }

    placeholder.asyncState = 'PENDING_AI';
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
