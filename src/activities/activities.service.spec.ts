import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FeelingLabel, ResourceCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ActivitiesService } from './activities.service.js';

describe('ActivitiesService', () => {
  let service: ActivitiesService;
  let prisma: {
    wellbeingActivity: Record<string, ReturnType<typeof vi.fn>>;
    activitySession: Record<string, ReturnType<typeof vi.fn>>;
    conversation: Record<string, ReturnType<typeof vi.fn>>;
  };
  let studentsService: { ensureProfile: ReturnType<typeof vi.fn> };

  const student = { id: 'student-1' };
  const activity = {
    id: 'act-1',
    slug: 'box-breathing',
    title: 'Box Breathing (4-4-4-4)',
    description: 'Steady the breath.',
    category: ResourceCategory.GROUNDING,
    durationSeconds: 120,
    tags: ['Panic'],
    active: true,
    approved: true,
    steps: [{ type: 'breath-pacing', title: 'Box breath', cycles: 6, pattern: [] }],
  };

  beforeEach(async () => {
    prisma = {
      wellbeingActivity: { findMany: vi.fn(), findFirst: vi.fn() },
      activitySession: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
      },
      conversation: { findFirst: vi.fn() },
    };
    studentsService = { ensureProfile: vi.fn().mockResolvedValue(student) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivitiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: StudentsService, useValue: studentsService },
      ],
    }).compile();
    service = module.get(ActivitiesService);
  });

  describe('list', () => {
    it('returns only active + approved cards and keeps steps out of the payload', async () => {
      const items = [{ id: 'act-1', slug: 'box-breathing', title: 'Box Breathing (4-4-4-4)' }];
      prisma.wellbeingActivity.findMany.mockResolvedValue(items);

      const result = await service.list({});

      expect(result).toEqual({ items });
      const args = prisma.wellbeingActivity.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        select: Record<string, unknown>;
      };
      expect(args.where).toEqual({ active: true, approved: true });
      expect(args.select.steps).toBeUndefined();
    });

    it('filters by category when the query asks for one', async () => {
      prisma.wellbeingActivity.findMany.mockResolvedValue([]);

      await service.list({ category: ResourceCategory.GROUNDING });

      expect(prisma.wellbeingActivity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            active: true,
            approved: true,
            category: ResourceCategory.GROUNDING,
          },
        }),
      );
    });
  });

  describe('detail', () => {
    it('returns the full activity (steps included) for a startable slug', async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(activity);

      const result = await service.detail('box-breathing');

      expect(result).toBe(activity);
      expect(prisma.wellbeingActivity.findFirst).toHaveBeenCalledWith({
        where: { slug: 'box-breathing', active: true, approved: true },
      });
    });

    it('404s an unknown or unapproved slug', async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(null);

      await expect(service.detail('nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('start', () => {
    it('creates a SELF session when started from the catalogue', async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(activity);
      prisma.activitySession.create.mockResolvedValue({ id: 'sess-1' });

      const result = await service.start('user-1', 'box-breathing', {});

      expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.activitySession.create).toHaveBeenCalledWith({
        data: {
          studentId: 'student-1',
          activityId: 'act-1',
          conversationId: null,
          intentId: null,
          recommendedBy: 'SELF',
        },
      });
      expect(result).toEqual({ session: { id: 'sess-1' }, activity });
    });

    it('labels an AI recommendation and verifies conversation ownership', async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(activity);
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
      prisma.activitySession.create.mockResolvedValue({ id: 'sess-1' });

      await service.start('user-1', 'box-breathing', {
        conversationId: 'conv-1',
        intentId: 'ACUTE_PANIC',
      });

      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'conv-1', studentId: 'student-1' },
        select: { id: true },
      });
      expect(prisma.activitySession.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conversationId: 'conv-1',
          intentId: 'ACUTE_PANIC',
          recommendedBy: 'AI',
        }),
      });
    });

    it("404s a conversation that is not the student's", async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(activity);
      prisma.conversation.findFirst.mockResolvedValue(null);

      await expect(
        service.start('user-1', 'box-breathing', { conversationId: 'conv-x' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.activitySession.create).not.toHaveBeenCalled();
    });

    it('404s an unknown or unapproved slug before any write', async () => {
      prisma.wellbeingActivity.findFirst.mockResolvedValue(null);

      await expect(service.start('user-1', 'nope', {})).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.activitySession.create).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('records completion, feeling and note for the owner', async () => {
      prisma.activitySession.findFirst.mockResolvedValue({
        id: 'sess-1',
        studentId: 'student-1',
        completedAt: null,
      });
      prisma.activitySession.update.mockResolvedValue({ id: 'sess-1', feelingAfter: FeelingLabel.CALM });

      const result = await service.complete('user-1', 'sess-1', {
        feelingAfter: FeelingLabel.CALM,
        noteAfter: 'Kept at it.',
      });

      expect(prisma.activitySession.findFirst).toHaveBeenCalledWith({
        where: { id: 'sess-1', studentId: 'student-1' },
      });
      const args = prisma.activitySession.update.mock.calls[0][0] as {
        where: { id: string };
        data: { completedAt: Date; feelingAfter: FeelingLabel; noteAfter: string };
      };
      expect(args.where).toEqual({ id: 'sess-1' });
      expect(args.data.completedAt).toBeInstanceOf(Date);
      expect(args.data.feelingAfter).toBe(FeelingLabel.CALM);
      expect(args.data.noteAfter).toBe('Kept at it.');
      expect(result).toEqual({ id: 'sess-1', feelingAfter: FeelingLabel.CALM });
    });

    it('is idempotent: a completed session is returned untouched, feel-after stays immutable', async () => {
      const completed = {
        id: 'sess-1',
        studentId: 'student-1',
        completedAt: new Date('2026-10-06T10:00:00Z'),
        feelingAfter: FeelingLabel.HOPEFUL,
      };
      prisma.activitySession.findFirst.mockResolvedValue(completed);

      const result = await service.complete('user-1', 'sess-1', {
        feelingAfter: FeelingLabel.SAD_LOW,
      });

      expect(result).toBe(completed);
      expect(prisma.activitySession.update).not.toHaveBeenCalled();
    });

    it("404s a session that is not the student's", async () => {
      prisma.activitySession.findFirst.mockResolvedValue(null);

      await expect(
        service.complete('user-1', 'sess-x', { feelingAfter: FeelingLabel.CALM }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.activitySession.update).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('returns the student sessions, newest first, with activity cards', async () => {
      const items = [{ id: 'sess-1', activity: { slug: 'box-breathing', title: 'Box Breathing (4-4-4-4)' } }];
      prisma.activitySession.findMany.mockResolvedValue(items);

      const result = await service.history('user-1');

      expect(result).toEqual({ items, count: 1 });
      expect(prisma.activitySession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: 'student-1' },
          orderBy: { startedAt: 'desc' },
          take: 50,
        }),
      );
    });
  });
});
