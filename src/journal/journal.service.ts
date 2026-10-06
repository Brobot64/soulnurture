import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateJournalDto } from './dto/create-journal.dto.js';
import type { UpdateJournalDto } from './dto/update-journal.dto.js';

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.journalEntry.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateJournalDto) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.journalEntry.create({
      data: {
        studentId: student.id,
        title: dto.title,
        content: dto.content,
        prompt: dto.prompt,
        private: true,
      },
    });
  }

  private async owned(id: string, studentId: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    if (entry.studentId !== studentId) throw new ForbiddenException();
    return entry;
  }

  async getOne(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.owned(id, student.id);
  }

  async update(userId: string, id: string, dto: UpdateJournalDto) {
    const student = await this.studentsService.ensureProfile(userId);
    await this.owned(id, student.id);
    return this.prisma.journalEntry.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
      },
    });
  }

  async delete(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    await this.owned(id, student.id);
    return this.prisma.journalEntry.delete({ where: { id } });
  }
}