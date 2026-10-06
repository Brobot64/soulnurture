import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { UpdatePrivacyDto } from './dto/update-privacy.dto.js';

@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly auditService: AuditService,
  ) {}

  async get(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    return this.prisma.privacyPreference.upsert({
      where: { studentId: student.id },
      create: { studentId: student.id },
      update: {},
    });
  }

  async update(userId: string, dto: UpdatePrivacyDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const changed = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => typeof v === 'boolean'),
    );
    const pref = await this.prisma.privacyPreference.upsert({
      where: { studentId: student.id },
      create: {
        studentId: student.id,
        shareAiCopingHubNotes: dto.shareAiCopingHubNotes ?? false,
        allowParentGuardianNotification: dto.allowParentGuardianNotification ?? false,
        requestPeerSupportCompanion: dto.requestPeerSupportCompanion ?? false,
      },
      update: changed,
    });
    await this.auditService.log({
      actorId: userId,
      action: 'privacy.updated',
      entity: 'PrivacyPreference',
      entityId: pref.id,
    });
    return pref;
  }
}
