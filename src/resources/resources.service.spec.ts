import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ResourcesService } from './resources.service.js';

describe('ResourcesService', () => {
  let service: ResourcesService;
  let prisma: {
    wellbeingResource: Record<string, ReturnType<typeof vi.fn>>;
    toolboxItem: Record<string, ReturnType<typeof vi.fn>>;
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
  };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    prisma = {
      wellbeingResource: { findMany: vi.fn(), findFirst: vi.fn() },
      toolboxItem: {
        count: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
      emotionalCheckIn: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourcesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
      ],
    }).compile();

    service = module.get(ResourcesService);
  });

  it('builds an active/approved where filter with category + search', async () => {
    prisma.wellbeingResource.findMany.mockResolvedValue([]);
    prisma.toolboxItem.count.mockResolvedValue(2);

    await service.list('user-1', { category: 'GROUNDING', search: 'breath' });

    const where = prisma.wellbeingResource.findMany.mock.calls[0][0].where;
    expect(where.active).toBe(true);
    expect(where.approved).toBe(true);
    expect(where.category).toBe('GROUNDING');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { title: { contains: 'breath', mode: 'insensitive' } },
        { description: { contains: 'breath', mode: 'insensitive' } },
      ]),
    );
    expect(prisma.toolboxItem.count).toHaveBeenCalledWith({
      where: { studentId: student.id },
    });
  });

  it('filters by savedOnly using the students toolbox', async () => {
    prisma.wellbeingResource.findMany.mockResolvedValue([]);
    prisma.toolboxItem.count.mockResolvedValue(0);

    await service.list('user-1', { savedOnly: 'true' });

    const where = prisma.wellbeingResource.findMany.mock.calls[0][0].where;
    expect(where.toolboxItems).toEqual({ some: { studentId: student.id } });
  });

  it('returns tailored stress resources for a high-stress check-in', async () => {
    prisma.emotionalCheckIn.findUnique.mockResolvedValue({
      id: 'checkin-1',
      feeling: 'OVERWHELMED',
    });
    prisma.wellbeingResource.findMany.mockResolvedValue([
      { id: 'r1', title: 'Guided Breath' },
    ]);

    const result = await service.tailored('user-1', 'checkin-1');

    const where = prisma.wellbeingResource.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { category: 'EXAM_STRESS' },
      { category: 'GROUNDING' },
      { category: 'ANXIETY' },
    ]);
    expect(result.rationale).toContain('check-in');
    expect(result.items).toHaveLength(1);
  });

  it('throws NotFound when saving an unapproved/inactive resource', async () => {
    prisma.wellbeingResource.findFirst.mockResolvedValue(null);
    await expect(service.saveToolbox('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('saves a resource to the toolbox (idempotent upsert)', async () => {
    prisma.wellbeingResource.findFirst.mockResolvedValue({ id: 'r1' });
    prisma.toolboxItem.upsert.mockResolvedValue({});
    prisma.toolboxItem.findMany.mockResolvedValue([
      { resource: { id: 'r1', title: 'T' } },
    ]);

    await service.saveToolbox('user-1', 'r1');

    expect(prisma.toolboxItem.upsert).toHaveBeenCalledWith({
      where: { studentId_resourceId: { studentId: student.id, resourceId: 'r1' } },
      create: { studentId: student.id, resourceId: 'r1' },
      update: {},
    });
  });
});