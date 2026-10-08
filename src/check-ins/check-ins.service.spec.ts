import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { CheckInsService } from './check-ins.service.js';

describe('CheckInsService', () => {
  let service: CheckInsService;
  let prisma: {
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
      emotionalCheckIn: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckInsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: {
            ensureProfile: vi.fn().mockResolvedValue(student),
          },
        },
      ],
    }).compile();

    service = module.get(CheckInsService);
  });

  it('creates a check-in for the student', async () => {
    prisma.emotionalCheckIn.create.mockResolvedValue({
      id: 'checkin-1',
      studentId: student.id,
      feeling: 'OVERWHELMED',
      intensity: 7,
      description: 'Piles of mock exams',
      triggers: ['exams'],
    });

    const result = await service.create('user-1', {
      feeling: 'OVERWHELMED',
      intensity: 7,
      description: 'Piles of mock exams',
      triggers: ['exams'],
    });

    expect(prisma.emotionalCheckIn.create).toHaveBeenCalledWith({
      data: {
        studentId: student.id,
        feeling: 'OVERWHELMED',
        intensity: 7,
        description: 'Piles of mock exams',
        triggers: ['exams'],
      },
    });
    expect(result.id).toBe('checkin-1');
  });

  it('lists only the students own check-ins', async () => {
    prisma.emotionalCheckIn.findMany.mockResolvedValue([
      { id: 'c1', studentId: student.id },
    ]);
    const result = await service.listMine('user-1');
    expect(prisma.emotionalCheckIn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: student.id } }),
    );
    expect(result.items).toHaveLength(1);
  });

  it('throws NotFoundException for a missing check-in', async () => {
    prisma.emotionalCheckIn.findUnique.mockResolvedValue(null);
    await expect(service.getOne('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('forbids reading another students check-in', async () => {
    prisma.emotionalCheckIn.findUnique.mockResolvedValue({
      id: 'c1',
      studentId: 'student-2',
    });
    await expect(service.getOne('user-1', 'c1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('history', () => {
    it('returns closed-conversation check-ins newest first with summaries', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([
        {
          id: 'ci-2',
          feeling: 'CALM',
          triggers: ['music'],
          createdAt: new Date('2026-10-07T09:00:00Z'),
          conversations: [
            {
              id: 'conv-2',
              summary: { summary: 'Talked through exam nerves' },
            },
          ],
        },
        {
          id: 'ci-1',
          feeling: 'OVERWHELMED',
          triggers: ['exams'],
          createdAt: new Date('2026-10-05T18:30:00Z'),
          conversations: [{ id: 'conv-1', summary: null }],
        },
      ]);

      const result = await service.history('user-1');

      expect(prisma.emotionalCheckIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            studentId: student.id,
            conversations: { some: { status: 'CLOSED' } },
          },
        }),
      );
      expect(result.items).toEqual([
        {
          checkInId: 'ci-2',
          feeling: 'CALM',
          triggers: ['music'],
          createdAt: new Date('2026-10-07T09:00:00Z'),
          conversationId: 'conv-2',
          summary: 'Talked through exam nerves',
        },
        {
          checkInId: 'ci-1',
          feeling: 'OVERWHELMED',
          triggers: ['exams'],
          createdAt: new Date('2026-10-05T18:30:00Z'),
          conversationId: 'conv-1',
          summary: null,
        },
      ]);
    });

    it('falls back to a null summary and conversation id when absent', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([
        {
          id: 'ci-3',
          feeling: 'SAD',
          triggers: [],
          createdAt: new Date('2026-10-06T12:00:00Z'),
          conversations: [],
        },
      ]);

      const result = await service.history('user-1');

      expect(result.items).toEqual([
        {
          checkInId: 'ci-3',
          feeling: 'SAD',
          triggers: [],
          createdAt: new Date('2026-10-06T12:00:00Z'),
          conversationId: null,
          summary: null,
        },
      ]);
    });
  });
});