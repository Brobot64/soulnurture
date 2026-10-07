import { Inject, Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { MemoryRepository } from '../memory/memory.repository.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface AiContext {
  student: { firstName: string | null; preferredLanguage: string | null };
  currentCheckIn: {
    feeling: string | null;
    intensity: string | null;
    description: string | null;
  } | null;
  recentConversation: { role: 'USER' | 'ASSISTANT'; content: string }[];
  relevantReflection: { content: string } | null;
  relevantResources: {
    id: string;
    title: string;
    type: string;
    category: string;
    description: string;
  }[];
  currentJourneyStep: number | null;
  /**
   * Session-summary memory (Phase C step 3): recent digests + pending
   * follow-up hooks + vector-similar summaries for the current message.
   * Null when there is nothing to carry — the model then simply has no
   * long-term memory for this student yet.
   */
  carriedContext: {
    summaries: {
      id: string;
      summary: string;
      topics: string[];
      emotionalTrend: string | null;
      createdAt: Date;
    }[];
    followUpHooks: { followUpHook: string; createdAt: Date }[];
  } | null;
}

@Injectable()
export class AiContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryRepository,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async build(params: {
    studentId: string;
    conversationId: string;
    checkInId?: string | null;
    /** Current user message — drives vector-similar memory recall. */
    currentMessageText?: string;
  }): Promise<AiContext> {
    const messageLimit = this.aiConfig.context.messageLimit;
    const charLimit = this.aiConfig.context.characterLimit;

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: params.studentId },
      select: { firstName: true, preferredLanguage: true },
    });

    const checkIn = params.checkInId
      ? await this.prisma.emotionalCheckIn.findUnique({
          where: { id: params.checkInId },
          select: { feeling: true, intensity: true, description: true },
        })
      : null;

    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId: params.conversationId,
        role: { in: [MessageRole.USER, MessageRole.ASSISTANT] },
      },
      orderBy: { createdAt: 'desc' },
      take: messageLimit,
      select: { role: true, content: true },
    });

    const recent = messages.reverse().map((m) => ({
      role: m.role as 'USER' | 'ASSISTANT',
      content: m.content,
    }));

    let used = 0;
    const trimmed: typeof recent = [];
    for (const m of recent) {
      if (used + m.content.length > charLimit) break;
      trimmed.push(m);
      used += m.content.length;
    }

    const resources = await this.prisma.wellbeingResource.findMany({
      where: { active: true, approved: true },
      take: 8,
      select: { id: true, title: true, type: true, category: true, description: true },
    });

    const memory = await this.memory.recall({
      studentId: params.studentId,
      currentMessageText: params.currentMessageText,
    });
    const summaries = [...memory.recents, ...memory.similar].slice(0, 4);
    const carriedContext =
      summaries.length === 0 && memory.hooks.length === 0
        ? null
        : { summaries, followUpHooks: memory.hooks };

    return {
      student: {
        firstName: student?.firstName ?? null,
        preferredLanguage: student?.preferredLanguage ?? null,
      },
      currentCheckIn: checkIn
        ? {
            feeling: checkIn.feeling,
            intensity: checkIn.intensity,
            description: checkIn.description,
          }
        : null,
      recentConversation: trimmed,
      relevantReflection: null,
      relevantResources: resources.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        category: r.category,
        description: r.description.slice(0, 200),
      })),
      currentJourneyStep: checkIn ? 2 : null,
      carriedContext,
    };
  }
}
