import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateStudentDto } from './dto/update-student.dto.js';

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async ensureProfile(userId: string) {
    const existing = await this.prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (existing) return existing;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const parts = user.name.trim().split(/\s+/);
    return this.prisma.studentProfile.create({
      data: {
        userId,
        firstName: parts[0] || user.name,
        lastName: parts.slice(1).join(' ') || null,
        displayName: parts[0] || user.name,
      },
    });
  }

  getMe(userId: string) {
    return this.ensureProfile(userId);
  }

  async updateMe(userId: string, dto: UpdateStudentDto) {
    const before = await this.ensureProfile(userId);
    const student = await this.prisma.studentProfile.update({
      where: { userId },
      data: dto,
    });
    // Language preference changes are audited: they alter how the AI replies
    // to every subsequent message, so the trail must show who switched when.
    if (
      dto.preferredLanguage &&
      dto.preferredLanguage !== before.preferredLanguage
    ) {
      await this.auditService.log({
        actorId: userId,
        action: 'student.language_changed',
        entity: 'StudentProfile',
        entityId: student.id,
        meta: {
          from: before.preferredLanguage,
          to: dto.preferredLanguage,
        },
      });
    }
    return student;
  }

  async getSanctuary(userId: string) {
    const student = await this.ensureProfile(userId);
    const latestCheckIn = await this.prisma.emotionalCheckIn.findFirst({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, feeling: true, intensity: true, createdAt: true },
    });

    return {
      student,
      greeting: `Welcome back, ${student.displayName ?? student.firstName}`,
      commonTriggersToday: [] as string[],
      latestCheckIn,
      sosAvailable: true,
    };
  }
}
