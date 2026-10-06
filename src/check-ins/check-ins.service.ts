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
}
