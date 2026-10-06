import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';

@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.consentRecord.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async accept(userId: string, version: string) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.consentRecord.upsert({
      where: { studentId_version: { studentId: student.id, version } },
      update: { accepted: true, acceptedAt: new Date() },
      create: {
        studentId: student.id,
        version,
        accepted: true,
        acceptedAt: new Date(),
      },
    });
  }
}
