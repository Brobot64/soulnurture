import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupportRequestStatus, SupportTiming } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto.js';
import type { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';

@Injectable()
export class SupportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
    private readonly auditService: AuditService,
  ) {}

  listPeople() {
    return this.prisma.supportPerson.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(userId: string, dto: CreateSupportRequestDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const person = await this.prisma.supportPerson.findFirst({
      where: { id: dto.supportPersonId, active: true },
    });
    if (!person) throw new NotFoundException('Support person not found');

    const status =
      dto.timing === SupportTiming.URGENT_UNSAFE
        ? SupportRequestStatus.ESCALATED
        : SupportRequestStatus.PENDING;

    const request = await this.prisma.supportRequest.create({
      data: {
        studentId: student.id,
        supportPersonId: person.id,
        personType: dto.personType,
        timing: dto.timing,
        note: dto.note,
        checkInId: dto.checkInId,
        conversationId: dto.conversationId,
        status,
      },
      include: { supportPerson: true },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.created',
      entity: 'SupportRequest',
      entityId: request.id,
      meta: { timing: dto.timing, status },
    });

    return request;
  }

  async listMine(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const items = await this.prisma.supportRequest.findMany({
      where: { studentId: student.id },
      include: { supportPerson: true },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  }

  async getOne(userId: string, id: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const item = await this.prisma.supportRequest.findUnique({
      where: { id },
      include: { supportPerson: true },
    });
    if (!item) throw new NotFoundException('Support request not found');
    if (item.studentId !== student.id) throw new ForbiddenException();
    return item;
  }

  /**
   * Counsellor review (report simplified scope: status plus notes).
   * Professionals progress a request through its review statuses and attach
   * a review note; students see the updated status in their own list.
   */
  async review(
    userId: string,
    id: string,
    dto: ReviewSupportRequestDto,
  ) {
    const existing = await this.prisma.supportRequest.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Support request not found');

    const updated = await this.prisma.supportRequest.update({
      where: { id },
      data: {
        status: dto.status,
        reviewNote: dto.reviewNote ?? existing.reviewNote,
      },
      include: { supportPerson: true },
    });

    await this.auditService.log({
      actorId: userId,
      action: 'support_request.status_changed',
      entity: 'SupportRequest',
      entityId: id,
      meta: { from: existing.status, to: dto.status },
    });

    return updated;
  }
}
