import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CheckInAnswerState } from '@prisma/client';
import { ContentService } from '../content/content.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateCheckInDto } from './dto/create-check-in.dto.js';

@Injectable()
export class CheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly contentService: ContentService,
  ) {}

  async create(userId: string, dto: CreateCheckInDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const feelings = dto.feelings ?? [];
    const answers = dto.answers ?? [];
    for (const answer of answers) {
      if (
        answer.state === CheckInAnswerState.ANSWERED &&
        !answer.valueCode &&
        !answer.freeText?.trim()
      ) {
        throw new BadRequestException(
          `${answer.promptCode}: ANSWERED needs a chosen option or the students own words`,
        );
      }
      if (answer.state === CheckInAnswerState.NOT_PRESENTED) {
        // Only the server knows a prompt was never shown; accepting it from a
        // client would let "we did not ask" be claimed by whoever is asking.
        throw new BadRequestException(
          `${answer.promptCode}: NOT_PRESENTED is recorded by the platform, not the client`,
        );
      }
    }
    await this.contentService.assertAskable([
      ...feelings.map((f) => f.code).filter((code): code is string => Boolean(code)),
      ...answers.map((a) => a.promptCode),
      ...answers.map((a) => a.valueCode).filter((code): code is string => Boolean(code)),
    ]);
    return this.prisma.emotionalCheckIn.create({
      data: {
        studentId: student.id,
        feeling: dto.feeling,
        intensity: dto.intensity,
        description: dto.description,
        triggers: dto.triggers ?? [],
        feelingSelections: {
          create: feelings.map((f) => ({
            termCode: f.code ?? null,
            termLabelSnapshot: f.label,
            isStudentFreeText: !f.code,
          })),
        },
        answers: {
          create: answers.map((a) => ({
            promptCode: a.promptCode,
            state: a.state,
            valueCode: a.valueCode ?? null,
            freeText: a.freeText ?? null,
          })),
        },
      },
    });
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.emotionalCheckIn.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const item = await this.prisma.emotionalCheckIn.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Check-in not found');
    if (item.studentId !== student.id) throw new ForbiddenException();
    return item;
  }

  /**
   * Guided check-in history: check-ins whose conversation is CLOSED, newest
   * first, with the AI session summary when one exists. Every entry opens
   * read-only (sends on non-ACTIVE conversations are rejected with 409), so
   * the frontend can render the whole list without per-item guards.
   */
  async history(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.emotionalCheckIn.findMany({
      where: {
        studentId: student.id,
        conversations: { some: { status: 'CLOSED' } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        conversations: {
          where: { status: 'CLOSED' },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { id: true, summary: { select: { summary: true } } },
        },
      },
    });
    return {
      items: items.map((checkIn) => {
        const conversation = checkIn.conversations[0] ?? null;
        return {
          checkInId: checkIn.id,
          feeling: checkIn.feeling,
          triggers: checkIn.triggers,
          createdAt: checkIn.createdAt,
          conversationId: conversation?.id ?? null,
          summary: conversation?.summary?.summary ?? null,
        };
      }),
    };
  }
}
