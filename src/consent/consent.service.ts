import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';

export interface ConsentStatus {
  version: string;
  accepted: boolean;
  acceptedAt: Date | null;
}

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

  async status(userId: string, version: string): Promise<ConsentStatus> {
    const student = await this.studentsService.ensureProfile(userId);
    const record = await this.prisma.consentRecord.findUnique({
      where: { studentId_version: { studentId: student.id, version } },
      select: { accepted: true, acceptedAt: true },
    });
    return {
      version,
      accepted: record?.accepted === true,
      acceptedAt: record?.acceptedAt ?? null,
    };
  }

  async hasAccepted(userId: string, version: string): Promise<boolean> {
    const student = await this.studentsService.ensureProfile(userId);
    return this.hasAcceptedForStudent(student.id, version);
  }

  /**
   * Same gate for callers that already resolved the student profile — avoids a
   * second ensureProfile round trip on the hot chat path.
   */
  async hasAcceptedForStudent(
    studentId: string,
    version: string,
  ): Promise<boolean> {
    const record = await this.prisma.consentRecord.findUnique({
      where: { studentId_version: { studentId, version } },
      select: { accepted: true },
    });
    return record?.accepted === true;
  }

  async accept(userId: string, version: string, metadata?: Prisma.InputJsonValue) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.consentRecord.upsert({
      where: { studentId_version: { studentId: student.id, version } },
      update: {
        accepted: true,
        acceptedAt: new Date(),
        ...(metadata ? { metadata } : {}),
      },
      create: {
        studentId: student.id,
        version,
        accepted: true,
        acceptedAt: new Date(),
        ...(metadata ? { metadata } : {}),
      },
    });
  }
}
