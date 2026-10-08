import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateCheckInDto } from './dto/create-check-in.dto.js';

@Injectable()
export class CheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async create(userId: string, dto: CreateCheckInDto) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.emotionalCheckIn.create({
      data: {
        studentId: student.id,
        feeling: dto.feeling,
        intensity: dto.intensity,
        description: dto.description,
        triggers: dto.triggers ?? [],
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
