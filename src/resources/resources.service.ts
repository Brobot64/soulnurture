import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import type { ResourceQueryDto } from './dto/resource-query.dto.js';

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
    await this.studentsService.ensureProfile(userId);
    let where: Prisma.WellbeingResourceWhereInput = {
      active: true,
      approved: true,
    };
    if (checkInId) {
      const checkIn = await this.prisma.emotionalCheckIn.findUnique({
        where: { id: checkInId },
      });
      if (
        checkIn &&
        (checkIn.feeling === 'OVERWHELMED' ||
          checkIn.feeling === 'ANXIOUS' ||
          checkIn.feeling === 'STRESSED')
      ) {
        where = {
          ...where,
          OR: [
            { category: 'EXAM_STRESS' },
            { category: 'GROUNDING' },
            { category: 'ANXIETY' },
          ],
        };
      }
    }
    const items = await this.prisma.wellbeingResource.findMany({
      where,
      take: 3,
      orderBy: { updatedAt: 'desc' },
    });
    return {
      rationale: 'Based on your recent check-in and reflection signals.',
      items,
    };
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
}
