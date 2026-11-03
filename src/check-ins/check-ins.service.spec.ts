import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContentService } from '../content/content.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { CheckInsService } from './check-ins.service.js';

describe('CheckInsService', () => {
  let service: CheckInsService;
  let prisma: {
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
  };
  let content: { assertAskable: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> };

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
    content = { assertAskable: vi.fn().mockResolvedValue(undefined), resolve: vi.fn() };

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
        { provide: ContentService, useValue: content },
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
        feelingSelections: { create: [] },
        answers: { create: [] },
      },
    });
    expect(result.id).toBe('checkin-1');
  });

  it('stores picked feelings as label snapshots and flags the students own words', async () => {
    prisma.emotionalCheckIn.create.mockResolvedValue({ id: 'checkin-1' });

    await service.create('user-1', {
      feeling: 'OVERWHELMED',
      intensity: 'A_LOT',
      feelings: [{ code: 'EMO-03', label: 'Wired and restless' }, { label: 'Like before exams but worse' }],
    });

    expect(content.assertAskable).toHaveBeenCalledWith(['EMO-03']);
    expect(prisma.emotionalCheckIn.create.mock.calls[0][0].data.feelingSelections.create).toEqual([
      {
        termCode: 'EMO-03',
        termLabelSnapshot: 'Wired and restless',
        isStudentFreeText: false,
      },
      {
        termCode: null,
        termLabelSnapshot: 'Like before exams but worse',
        isStudentFreeText: true,
      },
    ]);
  });

  it('keeps a skip visible as a skip instead of an absent answer', async () => {
    prisma.emotionalCheckIn.create.mockResolvedValue({ id: 'checkin-1' });

    await service.create('user-1', {
      feeling: 'SAD_LOW',
      intensity: 'SOMEWHAT',
      answers: [
        { promptCode: 'CP-05', state: 'ANSWERED', valueCode: 'CP-05-A', freeText: undefined },
        { promptCode: 'CP-06', state: 'SKIPPED' },
        { promptCode: 'CP-07', state: 'PREFER_NOT_TO_SAY' },
      ],
    });

    expect(content.assertAskable).toHaveBeenCalledWith([
      'CP-05',
      'CP-06',
      'CP-07',
      'CP-05-A',
    ]);
    const created = prisma.emotionalCheckIn.create.mock.calls[0][0].data.answers.create;
    expect(created).toEqual([
      { promptCode: 'CP-05', state: 'ANSWERED', valueCode: 'CP-05-A', freeText: null },
      { promptCode: 'CP-06', state: 'SKIPPED', valueCode: null, freeText: null },
      { promptCode: 'CP-07', state: 'PREFER_NOT_TO_SAY', valueCode: null, freeText: null },
    ]);
  });

  it('refuses to store answers to a withheld prompt and writes nothing', async () => {
    content.assertAskable.mockRejectedValue(new ForbiddenException('CP-09 is blocked'));

    await expect(
      service.create('user-1', {
        feeling: 'ANXIOUS',
        intensity: 'A_LOT',
        answers: [{ promptCode: 'CP-09', state: 'ANSWERED', freeText: 'yes' }],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.emotionalCheckIn.create).not.toHaveBeenCalled();
  });

  it('rejects an ANSWERED state with neither an option nor the students words', async () => {
    await expect(
      service.create('user-1', {
        feeling: 'ANXIOUS',
        intensity: 'A_LOT',
        answers: [{ promptCode: 'CP-04', state: 'ANSWERED', freeText: '   ' }],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.emotionalCheckIn.create).not.toHaveBeenCalled();
  });

  it('rejects a client claiming a prompt was never presented', async () => {
    await expect(
      service.create('user-1', {
        feeling: 'ANXIOUS',
        intensity: 'A_LOT',
        answers: [{ promptCode: 'CP-18', state: 'NOT_PRESENTED' }],
      }),
    ).rejects.toThrow(BadRequestException);
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