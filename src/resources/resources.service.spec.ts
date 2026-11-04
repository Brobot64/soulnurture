import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContentKind } from '@prisma/client';
import { ContentService } from '../content/content.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ResourcesService } from './resources.service.js';

describe('ResourcesService', () => {
  let service: ResourcesService;
  let content: { liveCodes: ReturnType<typeof vi.fn> };
  let prisma: {
    wellbeingResource: Record<string, ReturnType<typeof vi.fn>>;
    toolboxItem: Record<string, ReturnType<typeof vi.fn>>;
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
    resourceFeedback: Record<string, ReturnType<typeof vi.fn>>;
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    // One approved code by default, so the filter tests read as the old ones
    // did. Each gate test overrides this with what the register should say.
    content = { liveCodes: vi.fn().mockResolvedValue(new Set(['WN-01'])) };
    prisma = {
      wellbeingResource: { findMany: vi.fn(), findFirst: vi.fn() },
      toolboxItem: {
        count: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
      },
      emotionalCheckIn: { findFirst: vi.fn() },
      resourceFeedback: { create: vi.fn() },
      supportFlag: { create: vi.fn(), update: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourcesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
        { provide: ContentService, useValue: content },
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

  it('personalises only from the students own high-stress check-in and says so', async () => {
    prisma.emotionalCheckIn.findFirst.mockResolvedValue({
      id: 'checkin-1',
      feeling: 'OVERWHELMED',
    });
    prisma.wellbeingResource.findMany.mockResolvedValue([
      { id: 'r1', title: 'Guided Breath' },
    ]);

    const result = await service.tailored('user-1', 'checkin-1');

    expect(prisma.emotionalCheckIn.findFirst).toHaveBeenCalledWith({
      where: { id: 'checkin-1', studentId: student.id },
    });
    const where = prisma.wellbeingResource.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { category: 'EXAM_STRESS' },
      { category: 'GROUNDING' },
      { category: 'ANXIETY' },
    ]);
    expect(result.title).toBe('Picked for you');
    expect(result.basis).toBe('STATED_NEED');
    expect(result.rationale).toContain('overwhelmed');
    expect(result.rationale).not.toContain('reflection signals');
    expect(result.items).toHaveLength(1);
  });

  it('labels the list as featured when the student has no check-in at all', async () => {
    prisma.emotionalCheckIn.findFirst.mockResolvedValue(null);
    prisma.wellbeingResource.findMany.mockResolvedValue([]);

    const result = await service.tailored('user-1');

    expect(prisma.emotionalCheckIn.findFirst).toHaveBeenCalledWith({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(result.title).toBe('Featured resources');
    expect(result.basis).toBe('NEWEST_APPROVED');
    expect(result.rationale).not.toContain('You said');
  });

  it('reads the newest check-in itself when the caller names no id', async () => {
    // A student cannot know their check-in ids, so "from your check-in" has to
    // be resolved server-side or the surface is making the claim up.
    prisma.emotionalCheckIn.findFirst.mockResolvedValue({
      id: 'checkin-newest',
      feeling: 'ANXIOUS',
    });
    prisma.wellbeingResource.findMany.mockResolvedValue([]);

    const result = await service.tailored('user-1');

    expect(result.title).toBe('Picked for you');
    expect(result.basis).toBe('STATED_NEED');
    expect(result.rationale).toContain('anxious');
  });

  it('does not personalise from a check-in belonging to another student', async () => {
    prisma.emotionalCheckIn.findFirst.mockResolvedValue(null);
    prisma.wellbeingResource.findMany.mockResolvedValue([]);

    const result = await service.tailored('user-1', 'someone-elses-checkin');

    expect(result.title).toBe('Featured resources');
    expect(result.basis).toBe('NEWEST_APPROVED');
    expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it('does not claim a feeling-specific grouping for a calm check-in', async () => {
    prisma.emotionalCheckIn.findFirst.mockResolvedValue({
      id: 'checkin-1',
      feeling: 'CALM',
    });
    prisma.wellbeingResource.findMany.mockResolvedValue([]);

    const result = await service.tailored('user-1', 'checkin-1');

    expect(result.title).toBe('Featured resources');
    expect(result.basis).toBe('NEWEST_APPROVED');
    expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.OR).toBeUndefined();
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

  it('records a what-next answer as one feedback row and no safeguarding write', async () => {
    prisma.wellbeingResource.findFirst.mockResolvedValue({ id: 'r1' });
    prisma.resourceFeedback.create.mockResolvedValue({});

    const result = await service.recordFeedback('user-1', {
      resourceId: 'r1',
      choice: 'WANT_TO_TALK',
    });

    expect(prisma.resourceFeedback.create).toHaveBeenCalledWith({
      data: {
        studentId: student.id,
        resourceId: 'r1',
        choice: 'WANT_TO_TALK',
      },
    });
    expect(prisma.supportFlag.create).not.toHaveBeenCalled();
    expect(prisma.supportFlag.update).not.toHaveBeenCalled();
    expect(result).toEqual({ recorded: true });
  });

  it('throws NotFound for feedback on an unapproved resource and writes nothing', async () => {
    prisma.wellbeingResource.findFirst.mockResolvedValue(null);

    await expect(
      service.recordFeedback('user-1', {
        resourceId: 'missing',
        choice: 'NOT_HELPFUL',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.resourceFeedback.create).not.toHaveBeenCalled();
  });

  describe('the content register decides what a student may see (Doc B §5, Doc C §1)', () => {
    it('reads only the codes the register currently approves', async () => {
      prisma.wellbeingResource.findMany.mockResolvedValue([]);
      prisma.toolboxItem.count.mockResolvedValue(0);

      await service.list('user-1', {});

      expect(content.liveCodes).toHaveBeenCalledWith({
        kind: ContentKind.WELLBEING_RESOURCE,
      });
      expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.contentCode).toEqual({
        in: ['WN-01'],
      });
    });

    it('empties the catalogue when nothing is approved, rather than falling back to the row boolean', async () => {
      // The five seeded placeholder rows carried approved: true and no code.
      // A register that approves nothing must show nothing, not those rows.
      content.liveCodes.mockResolvedValue(new Set());
      prisma.wellbeingResource.findMany.mockResolvedValue([]);
      prisma.toolboxItem.count.mockResolvedValue(0);

      await service.list('user-1', {});

      expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.contentCode).toEqual({
        in: [],
      });
    });

    it('gates the tailored surface with the same predicate it filters on', async () => {
      prisma.wellbeingResource.findMany.mockResolvedValue([]);

      await service.tailored('user-1');

      expect(prisma.wellbeingResource.findMany.mock.calls[0][0].where.contentCode).toEqual({
        in: ['WN-01'],
      });
    });

    it('keeps the stated-need narrowing on top of the register gate', async () => {
      prisma.emotionalCheckIn.findFirst.mockResolvedValue({
        id: 'checkin-1',
        feeling: 'STRESSED',
      });
      prisma.wellbeingResource.findMany.mockResolvedValue([]);

      await service.tailored('user-1', 'checkin-1');

      const where = prisma.wellbeingResource.findMany.mock.calls[0][0].where;
      expect(where.contentCode).toEqual({ in: ['WN-01'] });
      expect(where.OR).toHaveLength(3);
    });

    it('drops a toolbox row whose resource the register no longer approves', async () => {
      prisma.toolboxItem.findMany.mockResolvedValue([
        { resource: { id: 'r1', contentCode: 'WN-01', active: true, approved: true } },
        { resource: { id: 'r2', contentCode: null, active: true, approved: true } },
        { resource: { id: 'r3', contentCode: 'WN-02', active: true, approved: true } },
      ]);

      const result = await service.toolbox('user-1');

      expect(result.items.map((r) => r.id)).toEqual(['r1']);
      expect(result.count).toBe(1);
    });

    it('refuses to save a row that is approved on the table but unreviewed in the register', async () => {
      prisma.wellbeingResource.findFirst.mockResolvedValue(null);

      await expect(service.saveToolbox('user-1', 'r2')).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.wellbeingResource.findFirst.mock.calls[0][0].where).toEqual(
        expect.objectContaining({
          id: 'r2',
          contentCode: { in: ['WN-01'] },
        }),
      );
      expect(prisma.toolboxItem.upsert).not.toHaveBeenCalled();
    });

    it('will not take a what-next answer for an unreviewed resource', async () => {
      prisma.wellbeingResource.findFirst.mockResolvedValue(null);

      await expect(
        service.recordFeedback('user-1', { resourceId: 'r2', choice: 'NOT_HELPFUL' }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.wellbeingResource.findFirst.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ contentCode: { in: ['WN-01'] } }),
      );
      expect(prisma.resourceFeedback.create).not.toHaveBeenCalled();
    });
  });
});