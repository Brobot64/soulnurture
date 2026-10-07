import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { ActivityQueryDto } from './dto/activity-query.dto.js';
import type { CompleteActivitySessionDto } from './dto/complete-activity-session.dto.js';
import type { StartActivitySessionDto } from './dto/start-activity-session.dto.js';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  /**
   * Catalogue list — renderer cards only, so `steps` stays out of the
   * payload; GET /:slug and POST /:slug/sessions carry the full steps.
   */
  async list(query: ActivityQueryDto) {
    const where: Prisma.WellbeingActivityWhereInput = {
      active: true,
      approved: true,
      ...(query.category ? { category: query.category } : {}),
    };
    const items = await this.prisma.wellbeingActivity.findMany({
      where,
      orderBy: { title: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        category: true,
        durationSeconds: true,
        tags: true,
      },
    });
    return { items };
  }

  async detail(slug: string) {
    const activity = await this.prisma.wellbeingActivity.findFirst({
      where: { slug, active: true, approved: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    return activity;
  }

  async start(userId: string, slug: string, dto: StartActivitySessionDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const activity = await this.prisma.wellbeingActivity.findFirst({
      where: { slug, active: true, approved: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    if (dto.conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: dto.conversationId, studentId: student.id },
        select: { id: true },
      });
      if (!conversation) throw new NotFoundException('Conversation not found');
    }

    const session = await this.prisma.activitySession.create({
      data: {
        studentId: student.id,
        activityId: activity.id,
        conversationId: dto.conversationId ?? null,
        intentId: dto.intentId ?? null,
        recommendedBy: dto.conversationId ? 'AI' : 'SELF',
      },
    });
    return { session, activity };
  }

  async complete(userId: string, id: string, dto: CompleteActivitySessionDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const session = await this.prisma.activitySession.findFirst({
      where: { id, studentId: student.id },
    });
    if (!session) throw new NotFoundException('Activity session not found');

    // Idempotent completion: feel-after is measurement data — a repeat
    // request (double tap, retry) returns the completed record untouched.
    if (session.completedAt) return session;

    return this.prisma.activitySession.update({
      where: { id: session.id },
      data: {
        completedAt: new Date(),
        feelingAfter: dto.feelingAfter,
        noteAfter: dto.noteAfter ?? null,
      },
    });
  }

  async history(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.activitySession.findMany({
      where: { studentId: student.id },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        activity: {
          select: {
            slug: true,
            title: true,
            category: true,
            durationSeconds: true,
          },
        },
      },
    });
    return { items, count: items.length };
  }
}
