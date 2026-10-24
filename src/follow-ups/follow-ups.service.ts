import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FollowUpStatus } from '@prisma/client';
import type { FollowUp } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ProfessionalsService } from '../professionals/professionals.service.js';
import { inSchool, schoolOf } from '../common/tenant/school-scope.js';
import type { CreateFollowUpDto } from './dto/follow-up.dto.js';
import type { UpdateFollowUpDto } from './dto/follow-up.dto.js';

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly professionalsService: ProfessionalsService,
  ) {}

  async listForUser(userId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
    });
    if (student) {
      return this.prisma.followUp.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: 'desc' },
      });
    }
    const professional = await this.prisma.professionalProfile.findUnique({
      where: { userId },
    });
    if (professional) {
      const schoolId = await schoolOf(this.prisma, userId);
      if (!schoolId) return [];
      return this.prisma.followUp.findMany({
        where: { professionalId: professional.id, ...inSchool(schoolId) },
        orderBy: { createdAt: 'desc' },
      });
    }
    return [];
  }

  /** Professional books a follow-up on a student (PENDING by default). */
  async create(userId: string, dto: CreateFollowUpDto): Promise<FollowUp> {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) throw new NotFoundException('Student profile not found');

    const student = await this.prisma.studentProfile.findFirst({
      where: { id: dto.studentId, user: { schoolId } },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Student profile not found');

    if (dto.supportRequestId) {
      const supportRequest = await this.prisma.supportRequest.findFirst({
        where: {
          id: dto.supportRequestId,
          studentId: student.id,
          ...inSchool(schoolId),
        },
        select: { id: true },
      });
      if (!supportRequest)
        throw new NotFoundException('Support request not found');
    }

    const status = dto.status ?? FollowUpStatus.PENDING;
    if (status === FollowUpStatus.SCHEDULED && !dto.dueAt) {
      throw new BadRequestException('Scheduled follow-ups require a due date');
    }

    const professional = await this.professionalsService.ensureProfile(userId);
    const followUp = await this.prisma.followUp.create({
      data: {
        studentId: dto.studentId,
        professionalId: professional.id,
        supportRequestId: dto.supportRequestId,
        notes: dto.notes,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        status,
      },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'follow_up.created',
      entity: 'FollowUp',
      entityId: followUp.id,
      meta: { studentId: dto.studentId, dueAt: dto.dueAt ?? null },
      schoolId,
    });

    return followUp;
  }

  /** Owner advances the follow-up (status plus notes). */
  async update(
    userId: string,
    id: string,
    dto: UpdateFollowUpDto,
  ): Promise<FollowUp> {
    const schoolId = await schoolOf(this.prisma, userId);
    if (!schoolId) throw new NotFoundException('Follow-up not found');
    const followUp = await this.prisma.followUp.findFirst({
      where: { id, ...inSchool(schoolId) },
      include: { professional: { select: { userId: true } } },
    });
    if (!followUp) throw new NotFoundException('Follow-up not found');
    if (followUp.professional?.userId !== userId) {
      throw new ForbiddenException();
    }

    const status = dto.status ?? followUp.status;
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : followUp.dueAt;
    if (status === FollowUpStatus.SCHEDULED && !dueAt) {
      throw new BadRequestException('Scheduled follow-ups require a due date');
    }

    const updated = await this.prisma.followUp.update({
      where: { id },
      data: {
        status: dto.status,
        notes: dto.notes,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        completedAt:
          dto.status === FollowUpStatus.COMPLETED ? new Date() : undefined,
      },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'follow_up.updated',
      entity: 'FollowUp',
      entityId: id,
      meta: { status },
      schoolId,
    });

    return updated;
  }
}
