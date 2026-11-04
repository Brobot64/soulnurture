import { Test, type TestingModule } from '@nestjs/testing';
import { FollowUpStatus, SupportRequestStatus, SupportTiming } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { HistoryService } from './history.service.js';

const student = { id: 'student-1', userId: 'user-1' };

/** A check-in with nothing behind it — the design's "Check-in only" row. */
const bareCheckIn = {
  id: 'checkin-1',
  studentId: student.id,
  createdAt: new Date('2026-10-19T09:00:00Z'),
  feeling: 'CALM',
  intensity: 'MEDIUM',
  triggers: [],
  description: null,
  conversations: [],
  supportRequests: [],
};

const reflectedCheckIn = {
  id: 'checkin-2',
  studentId: student.id,
  createdAt: new Date('2026-10-27T09:05:00Z'),
  feeling: 'OVERWHELMED',
  intensity: 'HIGH',
  triggers: ['exams'],
  description: 'The expectations feel like too much',
  conversations: [
    {
      id: 'conversation-2',
      status: 'CLOSED',
      createdAt: new Date('2026-10-27T09:06:00Z'),
      summary: { summary: 'Felt backed up by exams, chose an idea.' },
      messages: [{ viaVoice: false }, { viaVoice: true }],
    },
  ],
  supportRequests: [
    {
      id: 'request-2',
      status: SupportRequestStatus.ACCEPTED,
      timing: SupportTiming.GENTLE_1_2_DAYS,
      createdAt: new Date('2026-10-27T09:08:00Z'),
      followUps: [{ status: FollowUpStatus.PENDING }],
    },
  ],
};

describe('HistoryService', () => {
  let service: HistoryService;
  let prisma: {
    emotionalCheckIn: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    conversationMessage: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    prisma = {
      emotionalCheckIn: { findMany: vi.fn(), findFirst: vi.fn() },
      conversationMessage: { findMany: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StudentsService, useValue: { ensureProfile: vi.fn().mockResolvedValue(student) } },
      ],
    }).compile();

    service = module.get(HistoryService);
  });

  describe('list', () => {
    it('keeps a check-in with no reflection at all — that row is the history', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([bareCheckIn, reflectedCheckIn]);

      const { items } = await service.list(student.userId);

      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ checkInId: 'checkin-1', reflection: null, supportRequest: null });
      expect(prisma.emotionalCheckIn.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: student.id },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('names the reflection lane from the stored voice flag, never from the text', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([reflectedCheckIn]);

      const { items } = await service.list(student.userId);

      expect(items[0].reflection).toMatchObject({
        conversationId: 'conversation-2',
        status: 'CLOSED',
        turnCount: 2,
        viaVoice: true,
        summary: 'Felt backed up by exams, chose an idea.',
      });
    });

    it('treats a typed-only reflection as typed', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([
        {
          ...reflectedCheckIn,
          conversations: [{ ...reflectedCheckIn.conversations[0], messages: [{ viaVoice: false }] }],
        },
      ]);

      const { items } = await service.list(student.userId);

      expect(items[0].reflection?.viaVoice).toBe(false);
    });

    it('carries the request through the same derivation the staff queue uses', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([reflectedCheckIn]);

      const { items } = await service.list(student.userId);

      expect(items[0].supportRequest).toEqual({
        id: 'request-2',
        createdAt: expect.any(Date),
        status: SupportRequestStatus.ACCEPTED,
        queueStatus: 'REVIEWED',
        followUpState: 'REQUIRED',
        urgency: 'NORMAL',
      });
    });

    it('keeps a request the student called unsafe urgent after a professional acts on it', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([
        {
          ...reflectedCheckIn,
          supportRequests: [
            {
              ...reflectedCheckIn.supportRequests[0],
              timing: SupportTiming.URGENT_UNSAFE,
              followUps: [{ status: FollowUpStatus.COMPLETED }],
            },
          ],
        },
      ]);

      const { items } = await service.list(student.userId);

      expect(items[0].supportRequest).toMatchObject({
        queueStatus: 'REVIEWED',
        followUpState: 'COMPLETED',
        urgency: 'URGENT',
      });
    });

    it('counts each tab from the rows it actually has', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([bareCheckIn, reflectedCheckIn]);

      const { counts } = await service.list(student.userId);

      expect(counts).toEqual({ all: 2, checkIns: 2, reflections: 1, supportRequests: 1 });
    });

    it('selects nothing a professional owns, so the page cannot leak it', async () => {
      prisma.emotionalCheckIn.findMany.mockResolvedValue([reflectedCheckIn]);

      const { items } = await service.list(student.userId);

      expect(Object.keys(items[0]).sort()).toEqual(
        ['checkInId', 'createdAt', 'feeling', 'intensity', 'reflection', 'supportRequest', 'triggers'].sort(),
      );
      expect(items[0].supportRequest).not.toHaveProperty('reviewNote');
      expect(items[0].supportRequest).not.toHaveProperty('initialMessage');
      expect(items[0].reflection).not.toHaveProperty('messages');
    });
  });

  describe('detail', () => {
    it('returns the student’s own turns and replies for the newest reflection', async () => {
      prisma.emotionalCheckIn.findFirst.mockResolvedValue(reflectedCheckIn);
      prisma.conversationMessage.findMany.mockResolvedValue([
        { id: 'm1', role: 'USER', content: 'The expectations feel like too much', viaVoice: false },
      ]);

      const entry = await service.detail(student.userId, 'checkin-2');

      expect(entry).toMatchObject({ checkInId: 'checkin-2', feeling: 'OVERWHELMED' });
      expect(entry?.messages).toHaveLength(1);
      expect(prisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { conversationId: 'conversation-2' } }),
      );
    });

    it('filters ownership in the query so another student’s id reads as not found', async () => {
      prisma.emotionalCheckIn.findFirst.mockResolvedValue(null);

      await expect(service.detail(student.userId, 'someone-elses-checkin')).resolves.toBeNull();

      expect(prisma.emotionalCheckIn.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'someone-elses-checkin', studentId: student.id } }),
      );
      expect(prisma.conversationMessage.findMany).not.toHaveBeenCalled();
    });

    it('opens a check-in with no reflection without reading any messages', async () => {
      prisma.emotionalCheckIn.findFirst.mockResolvedValue(bareCheckIn);

      const entry = await service.detail(student.userId, 'checkin-1');

      expect(entry).toMatchObject({ reflection: null, messages: [] });
      expect(prisma.conversationMessage.findMany).not.toHaveBeenCalled();
    });

    it('reads only the student’s own fields for the detail too', async () => {
      prisma.emotionalCheckIn.findFirst.mockResolvedValue(reflectedCheckIn);
      prisma.conversationMessage.findMany.mockResolvedValue([]);

      const entry = await service.detail(student.userId, 'checkin-2');

      for (const message of entry?.messages ?? []) {
        expect(message).not.toHaveProperty('aiPayload');
        expect(message).not.toHaveProperty('report');
      }
      expect(prisma.conversationMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.not.objectContaining({ aiPayload: true }),
        }),
      );
    });
  });
});
