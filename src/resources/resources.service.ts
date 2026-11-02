import { Injectable, NotFoundException } from '@nestjs/common';
import { FeelingLabel, Prisma, ResourceCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { ResourceFeedbackDto } from './dto/resource-feedback.dto.js';
import type { ResourceQueryDto } from './dto/resource-query.dto.js';

/**
 * The only check-in feelings with an approved resource grouping (Doc B / G13).
 * Anything outside this map gets the neutral "featured" surface instead of a
 * personalisation claim, because no mapping has been reviewed for it.
 */
const STATED_NEED_CATEGORIES: ResourceCategory[] = [
  ResourceCategory.EXAM_STRESS,
  ResourceCategory.GROUNDING,
  ResourceCategory.ANXIETY,
];

const STATED_NEED_LABELS: Partial<Record<FeelingLabel, string>> = {
  OVERWHELMED: 'overwhelmed',
  ANXIOUS: 'anxious',
  STRESSED: 'stressed',
};

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async list(userId: string, query: ResourceQueryDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const where: Prisma.WellbeingResourceWhereInput = {
      active: true,
      approved: true,
      ...(query.category ? { category: query.category } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    if (query.savedOnly === 'true') {
      where.toolboxItems = { some: { studentId: student.id } };
    }
    const items = await this.prisma.wellbeingResource.findMany({
      where,
      orderBy: { title: 'asc' },
    });
    const savedCount = await this.prisma.toolboxItem.count({
      where: { studentId: student.id },
    });
    return { items, savedCount };
  }

  async tailored(userId: string, checkInId?: string) {
    const student = await this.studentsService.ensureProfile(userId);
    let where: Prisma.WellbeingResourceWhereInput = {
      active: true,
      approved: true,
    };
    let title = 'Featured resources';
    let rationale = 'The newest approved resources, in case you want something to try.';
    if (checkInId) {
      const checkIn = await this.prisma.emotionalCheckIn.findFirst({
        where: { id: checkInId, studentId: student.id },
      });
      const statedNeed = checkIn ? STATED_NEED_LABELS[checkIn.feeling] : undefined;
      if (statedNeed) {
        where = { ...where, OR: STATED_NEED_CATEGORIES.map((category) => ({ category })) };
        title = 'Picked for you';
        rationale = `You said you feel ${statedNeed}, so these are the exam-stress, anxiety and grounding resources.`;
      }
    }
    const items = await this.prisma.wellbeingResource.findMany({
      where,
      take: 3,
      orderBy: { updatedAt: 'desc' },
    });
    return { title, rationale, items };
  }

  async toolbox(userId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const rows = await this.prisma.toolboxItem.findMany({
      where: { studentId: student.id },
      include: { resource: true },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((r) => r.resource), count: rows.length };
  }

  async saveToolbox(userId: string, resourceId: string) {
    const student = await this.studentsService.ensureProfile(userId);
    const resource = await this.prisma.wellbeingResource.findFirst({
      where: { id: resourceId, active: true, approved: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    await this.prisma.toolboxItem.upsert({
      where: {
        studentId_resourceId: { studentId: student.id, resourceId },
      },
      create: { studentId: student.id, resourceId },
      update: {},
    });
    return this.toolbox(userId);
  }

  /**
   * US-WR-D06. Writes one feedback row and nothing else: Doc C §5.1 forbids a
   * resource click, a "not helpful" or a refusal from becoming risk signal.
   */
  async recordFeedback(userId: string, body: ResourceFeedbackDto) {
    const student = await this.studentsService.ensureProfile(userId);
    const resource = await this.prisma.wellbeingResource.findFirst({
      where: { id: body.resourceId, active: true, approved: true },
      select: { id: true },
    });
    if (!resource) throw new NotFoundException('Resource not found');
    await this.prisma.resourceFeedback.create({
      data: {
        studentId: student.id,
        resourceId: resource.id,
        choice: body.choice,
      },
    });
    return { recorded: true };
  }
}
