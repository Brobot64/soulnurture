import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from '../ai/ai.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REALTIME_EVENTS } from '../realtime/realtime.events.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { StudentsService } from '../students/students.service.js';
import { ChatService } from './chat.service.js';

const student = {
  id: 's1',
  userId: 'u-student',
  firstName: 'Sam',
  lastName: 'Doe',
  classLabel: 'JSS 2',
  studentCode: 'STU-1',
};

const checkIn = {
  id: 'c1',
  feeling: 'ANXIOUS',
  intensity: 'HIGH',
  triggers: ['EXAMS'],
};

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    schoolId: 'school-1',
    status: 'ACTIVE',
    student: { userId: 'u-student', firstName: 'Sam' },
    professional: { userId: 'u-pro', user: { name: 'Ms. Ada' } },
    studentReadAt: null,
    professionalReadAt: null,
    ...overrides,
  };
}

function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => error as HttpException,
  );
}

describe('ChatService', () => {
  let service: ChatService;
  const prisma = {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    studentProfile: { findUnique: vi.fn() },
    professionalProfile: { findUnique: vi.fn() },
    emotionalCheckIn: { findFirst: vi.fn() },
    chatThread: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    chatMessage: { create: vi.fn(), count: vi.fn() },
  };
  const auditService = { log: vi.fn() };
  const aiService = { composeHandoffEntry: vi.fn() };
  const studentsService = { ensureProfile: vi.fn() };
  const notifications = { push: vi.fn() };
  const realtime = { emitToUser: vi.fn(), emitToSchoolProfessionals: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    studentsService.ensureProfile.mockResolvedValue(student);
    aiService.composeHandoffEntry.mockResolvedValue('AI entry note.');
    notifications.push.mockResolvedValue({ id: 'n1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
        { provide: AiService, useValue: aiService },
        { provide: StudentsService, useValue: studentsService },
        { provide: NotificationsService, useValue: notifications },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get(ChatService);
  });

  describe('createThread', () => {
    function givenActiveStudent(schoolId: string | null = 'school-1') {
      prisma.user.findUnique.mockResolvedValue(
        schoolId
          ? { schoolId, school: { id: schoolId, status: 'ACTIVE' } }
          : { schoolId: null, school: null },
      );
      prisma.chatThread.findFirst.mockResolvedValue(null);
      prisma.emotionalCheckIn.findFirst.mockResolvedValue(checkIn);
      prisma.chatThread.create.mockResolvedValue({ ...thread(), messages: [] });
      prisma.user.findMany.mockResolvedValue([{ id: 'u-pro-1' }, { id: 'u-pro-2' }]);
      prisma.chatThread.count.mockResolvedValue(3);
    }

    it('rejects users with no school (422 NO_SCHOOL)', async () => {
      givenActiveStudent(null);

      const rejection = await rejectionOf(service.createThread('u-student', {}));

      expect(rejection?.getStatus()).toBe(422);
      expect(rejection?.getResponse()).toMatchObject({ code: 'NO_SCHOOL' });
      expect(prisma.chatThread.create).not.toHaveBeenCalled();
    });

    it('blocks a suspended school with a coded 403', async () => {
      prisma.user.findUnique.mockResolvedValue({
        schoolId: 'school-1',
        school: { id: 'school-1', status: 'SUSPENDED' },
      });

      const rejection = await rejectionOf(service.createThread('u-student', {}));

      expect(rejection?.getStatus()).toBe(403);
      expect(rejection?.getResponse()).toMatchObject({ code: 'SCHOOL_SUSPENDED' });
    });

    it('blocks a second request while one is still PENDING (409)', async () => {
      givenActiveStudent();
      prisma.chatThread.findFirst.mockResolvedValue({ id: 't-open' });

      const rejection = await rejectionOf(service.createThread('u-student', {}));

      expect(rejection?.getStatus()).toBe(409);
      expect(rejection?.getResponse()).toMatchObject({
        code: 'PENDING_REQUEST_EXISTS',
      });
      expect(prisma.chatThread.create).not.toHaveBeenCalled();
    });

    it('creates the thread from the latest check-in: SYSTEM entry, read for the student, pool emit, per-professional notifications, audit', async () => {
      givenActiveStudent();

      await service.createThread('u-student', { note: 'maths is stressing me' });

      expect(prisma.emotionalCheckIn.findFirst).toHaveBeenCalledWith({
        where: { studentId: 's1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(aiService.composeHandoffEntry).toHaveBeenCalledWith({
        firstName: 'Sam',
        classLabel: 'JSS 2',
        feelingLabel: 'ANXIOUS',
        intensity: 'HIGH',
        triggers: ['EXAMS'],
        note: 'maths is stressing me',
      });
      const createArgs = prisma.chatThread.create.mock.calls[0][0];
      expect(createArgs.data).toMatchObject({
        schoolId: 'school-1',
        studentId: 's1',
        entryCheckInId: 'c1',
        aiEntrySummary: 'AI entry note.',
        messages: {
          create: {
            role: 'SYSTEM',
            content: 'AI entry note.',
            meta: { composedByAi: true },
          },
        },
      });
      expect(createArgs.data.studentReadAt).toBeInstanceOf(Date);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'u-student',
          action: 'chat.thread_created',
          entity: 'ChatThread',
          meta: { studentId: 's1', checkInId: 'c1', composedByAi: true },
        }),
      );
      expect(realtime.emitToSchoolProfessionals).toHaveBeenCalledWith(
        'school-1',
        REALTIME_EVENTS.CHAT_REQUEST_CREATED,
        {
          threadId: 't1',
          student: { firstName: 'Sam', classLabel: 'JSS 2' },
          pendingCount: 3,
        },
      );
      expect(notifications.push).toHaveBeenCalledTimes(2);
      expect(notifications.push).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-pro-1',
          type: 'CHAT_REQUEST',
          title: 'Sam asked to talk',
          data: { threadId: 't1' },
        }),
      );
    });

    it('404s when the attached check-inId belongs to another student', async () => {
      givenActiveStudent();
      prisma.emotionalCheckIn.findFirst.mockImplementation(
        async (args: { where: { id?: string } }) =>
          args.where.id === 'c-foreign' ? null : checkIn,
      );

      const rejection = await rejectionOf(
        service.createThread('u-student', { checkInId: 'c-foreign' }),
      );

      expect(rejection?.getStatus()).toBe(404);
      expect(prisma.chatThread.create).not.toHaveBeenCalled();
    });

    it('falls back to deterministic copy (without the note) when the AI composer fails', async () => {
      givenActiveStudent();
      aiService.composeHandoffEntry.mockRejectedValue(new Error('provider down'));

      await service.createThread('u-student', { note: 'sensitive words here' });

      const createArgs = prisma.chatThread.create.mock.calls[0][0];
      const entry = createArgs.data.messages.create;
      expect(entry.meta).toEqual({ composedByAi: false });
      expect(entry.content).toContain('Sam (JSS 2) asked to talk with someone.');
      expect(entry.content).toContain(
        'Their latest check-in was feeling anxious at high intensity.',
      );
      expect(entry.content).toContain('They mentioned EXAMS.');
      expect(entry.content).not.toContain('sensitive words here');
      expect(createArgs.data.aiEntrySummary).toBe(entry.content);
    });
  });

  describe('listThreads', () => {
    it('student branch: own threads newest-first with the professional visible', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'STUDENT' });
      prisma.chatThread.findMany.mockResolvedValue([{ id: 't1' }]);

      const result = await service.listThreads('u-student');

      expect(prisma.chatThread.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: 's1' },
          orderBy: { updatedAt: 'desc' },
        }),
      );
      expect(result).toEqual({ items: [{ id: 't1' }] });
    });

    it('staff branch: only threads they claimed', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'PSYCHOLOGIST' });
      prisma.professionalProfile.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatThread.findMany.mockResolvedValue([{ id: 't9' }]);

      const result = await service.listThreads('u-pro');

      expect(prisma.chatThread.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { professionalId: 'p1' } }),
      );
      expect(result).toEqual({ items: [{ id: 't9' }] });
    });

    it('staff without a professional profile see an empty list', async () => {
      prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR' });
      prisma.professionalProfile.findUnique.mockResolvedValue(null);

      await expect(service.listThreads('u-pro')).resolves.toEqual({ items: [] });
      expect(prisma.chatThread.findMany).not.toHaveBeenCalled();
    });

    it('404s for an unknown user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const rejection = await rejectionOf(service.listThreads('u-ghost'));

      expect(rejection?.getStatus()).toBe(404);
    });
  });

  describe('inbox', () => {
    it('lists the school PENDING pool oldest-first with student identity', async () => {
      prisma.user.findUnique.mockResolvedValue({ schoolId: 'school-1' });
      prisma.chatThread.findMany.mockResolvedValue([{ id: 't1' }]);

      await service.inbox('u-pro');

      expect(prisma.chatThread.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schoolId: 'school-1', status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('returns empty for staff without a school', async () => {
      prisma.user.findUnique.mockResolvedValue({ schoolId: null });

      await expect(service.inbox('u-pro')).resolves.toEqual({ items: [] });
      expect(prisma.chatThread.findMany).not.toHaveBeenCalled();
    });
  });

  describe('claim', () => {
    function givenClaimable() {
      prisma.user.findUnique.mockResolvedValue({ name: 'Ms. Ada', schoolId: 'school-1' });
      prisma.chatThread.findUnique.mockResolvedValue({
        id: 't1',
        schoolId: 'school-1',
        student: { userId: 'u-student' },
      });
      prisma.professionalProfile.findUnique.mockResolvedValue({ id: 'p1' });
      prisma.chatThread.updateMany.mockResolvedValue({ count: 1 });
    }

    it('claims race-safely, audits, notifies the student, and emits to both audiences', async () => {
      givenClaimable();
      prisma.chatThread.findUnique
        .mockResolvedValueOnce({
          id: 't1',
          schoolId: 'school-1',
          student: { userId: 'u-student' },
        })
        .mockResolvedValueOnce({ ...thread(), status: 'ACTIVE' });

      const result = await service.claim('u-pro', 't1');

      expect(prisma.chatThread.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', status: 'PENDING' },
        data: {
          professionalId: 'p1',
          status: 'ACTIVE',
          professionalReadAt: expect.any(Date),
          claimedAt: expect.any(Date),
        },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'chat.thread_claimed' }),
      );
      const payload = { threadId: 't1', professionalName: 'Ms. Ada' };
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-student',
        REALTIME_EVENTS.CHAT_THREAD_CLAIMED,
        payload,
      );
      expect(realtime.emitToSchoolProfessionals).toHaveBeenCalledWith(
        'school-1',
        REALTIME_EVENTS.CHAT_THREAD_CLAIMED,
        payload,
      );
      expect(notifications.push).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-student',
          type: 'CHAT_CLAIMED',
          data: { threadId: 't1' },
        }),
      );
      expect(result).toMatchObject({ id: 't1', status: 'ACTIVE' });
    });

    it('404s cross-school threads before any claim machinery runs', async () => {
      prisma.user.findUnique.mockResolvedValue({ name: 'Ms. Ada', schoolId: 'school-1' });
      prisma.chatThread.findUnique.mockResolvedValue({
        id: 't1',
        schoolId: 'school-OTHER',
        student: { userId: 'u-student' },
      });

      const rejection = await rejectionOf(service.claim('u-pro', 't1'));

      expect(rejection?.getStatus()).toBe(404);
      expect(prisma.professionalProfile.findUnique).not.toHaveBeenCalled();
      expect(prisma.chatThread.updateMany).not.toHaveBeenCalled();
    });

    it('loses the race with a coded 409 and zero side effects', async () => {
      givenClaimable();
      prisma.chatThread.updateMany.mockResolvedValue({ count: 0 });

      const rejection = await rejectionOf(service.claim('u-pro', 't1'));

      expect(rejection?.getStatus()).toBe(409);
      expect(rejection?.getResponse()).toMatchObject({ code: 'CHAT_THREAD_TAKEN' });
      expect(auditService.log).not.toHaveBeenCalled();
      expect(realtime.emitToUser).not.toHaveBeenCalled();
      expect(notifications.push).not.toHaveBeenCalled();
    });

    it('404s staff without a professional profile', async () => {
      givenClaimable();
      prisma.professionalProfile.findUnique.mockResolvedValue(null);

      const rejection = await rejectionOf(service.claim('u-pro', 't1'));

      expect(rejection?.getStatus()).toBe(404);
      expect(prisma.chatThread.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    function givenActiveThread() {
      prisma.chatThread.findUnique.mockResolvedValue(thread());
    }

    beforeEach(() => {
      // unreadSummary resolve for the recipient
      prisma.user.findUnique.mockResolvedValue({
        role: 'STUDENT',
        studentProfile: { id: 's1' },
        professionalProfile: null,
      });
      prisma.chatThread.findMany.mockResolvedValue([
        { id: 't1', studentReadAt: null },
      ]);
      prisma.chatMessage.count.mockResolvedValue(2);
      prisma.chatMessage.create.mockResolvedValue({
        id: 'm1',
        role: 'STUDENT',
        content: 'hello',
        viaVoice: false,
        createdAt: new Date('2026-10-09T10:00:00Z'),
      });
    });

    it('a student message lands, bumps their read marker, pushes to both rooms and the recipient', async () => {
      givenActiveThread();

      const message = await service.sendMessage('u-student', 't1', {
        content: 'hello',
      });

      expect(prisma.chatMessage.create.mock.calls[0][0].data).toMatchObject({
        threadId: 't1',
        senderUserId: 'u-student',
        role: 'STUDENT',
        content: 'hello',
        viaVoice: false,
      });
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { studentReadAt: expect.any(Date) },
      });
      const payload = {
        threadId: 't1',
        message: {
          id: 'm1',
          role: 'STUDENT',
          content: 'hello',
          viaVoice: false,
          createdAt: new Date('2026-10-09T10:00:00Z'),
        },
      };
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-student',
        REALTIME_EVENTS.CHAT_MESSAGE_NEW,
        payload,
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-pro',
        REALTIME_EVENTS.CHAT_MESSAGE_NEW,
        payload,
      );
      expect(notifications.push).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-pro',
          type: 'CHAT_REPLY',
          title: 'Sam replied',
          body: 'hello',
          data: { threadId: 't1' },
        }),
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-pro',
        REALTIME_EVENTS.CHAT_UNREAD_UPDATED,
        { total: 2, byThread: { t1: 2 } },
      );
      expect(message).toMatchObject({ id: 'm1', role: 'STUDENT' });
    });

    it('truncates the notification preview at 120 chars', async () => {
      givenActiveThread();
      const long = 'x'.repeat(150);

      await service.sendMessage('u-student', 't1', { content: long });

      const body = notifications.push.mock.calls[0][0].body as string;
      expect(body).toHaveLength(121);
      expect(body.endsWith('…')).toBe(true);
      expect(prisma.chatMessage.create.mock.calls[0][0].data.content).toBe(long);
    });

    it('404s outsiders (non-participants see nothing)', async () => {
      givenActiveThread();

      const rejection = await rejectionOf(
        service.sendMessage('u-stranger', 't1', { content: 'hi' }),
      );

      expect(rejection?.getStatus()).toBe(404);
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('409s unclaimed threads with CHAT_NOT_CLAIMED', async () => {
      prisma.chatThread.findUnique.mockResolvedValue(
        thread({ status: 'PENDING', professional: null }),
      );

      const rejection = await rejectionOf(
        service.sendMessage('u-student', 't1', { content: 'hi' }),
      );

      expect(rejection?.getStatus()).toBe(409);
      expect(rejection?.getResponse()).toMatchObject({ code: 'CHAT_NOT_CLAIMED' });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('409s closed threads with CHAT_THREAD_CLOSED', async () => {
      prisma.chatThread.findUnique.mockResolvedValue(thread({ status: 'CLOSED' }));

      const rejection = await rejectionOf(
        service.sendMessage('u-student', 't1', { content: 'hi' }),
      );

      expect(rejection?.getStatus()).toBe(409);
      expect(rejection?.getResponse()).toMatchObject({ code: 'CHAT_THREAD_CLOSED' });
    });

    it('429s over the per-minute cap without writing anything', async () => {
      givenActiveThread();
      vi.stubEnv('CHAT_RATE_LIMIT_PER_MINUTE', '2');

      await service.sendMessage('u-student', 't1', { content: 'one' });
      await service.sendMessage('u-student', 't1', { content: 'two' });
      const rejection = await rejectionOf(
        service.sendMessage('u-student', 't1', { content: 'three' }),
      );

      expect(rejection?.getStatus()).toBe(429);
      expect(prisma.chatMessage.create).toHaveBeenCalledTimes(2);
      expect(prisma.chatMessage.create.mock.calls[1][0].data.content).toBe('two');
    });

    it('a professional reply notifies the student instead', async () => {
      givenActiveThread();
      prisma.chatMessage.create.mockResolvedValue({
        id: 'm2',
        role: 'PROFESSIONAL',
        content: 'I am here',
        viaVoice: true,
        createdAt: new Date(),
      });

      await service.sendMessage('u-pro', 't1', { content: 'I am here', viaVoice: true });

      expect(prisma.chatMessage.create.mock.calls[0][0].data).toMatchObject({
        senderUserId: 'u-pro',
        role: 'PROFESSIONAL',
        viaVoice: true,
      });
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { professionalReadAt: expect.any(Date) },
      });
      expect(notifications.push).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-student',
          type: 'CHAT_REPLY',
          title: 'Ms. Ada replied',
        }),
      );
    });
  });

  describe('readThread', () => {
    it('marks my side read and pushes my fresh unread summary', async () => {
      prisma.chatThread.findUnique.mockResolvedValue({
        id: 't1',
        student: { userId: 'u-student' },
        professional: { userId: 'u-pro' },
      });
      prisma.user.findUnique.mockResolvedValue({
        role: 'STUDENT',
        studentProfile: { id: 's1' },
        professionalProfile: null,
      });
      prisma.chatThread.findMany.mockResolvedValue([]);

      const result = await service.readThread('u-student', 't1');

      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { studentReadAt: expect.any(Date) },
      });
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-student',
        REALTIME_EVENTS.CHAT_UNREAD_UPDATED,
        { total: 0, byThread: {} },
      );
      expect(result).toEqual({ id: 't1', read: true });
    });
  });

  describe('getThread', () => {
    it('returns the full thread to a participant', async () => {
      const full = { ...thread(), messages: [{ id: 'm1' }] };
      prisma.chatThread.findUnique.mockResolvedValue(full);

      await expect(service.getThread('u-student', 't1')).resolves.toBe(full);
    });

    it('404s non-participants', async () => {
      prisma.chatThread.findUnique.mockResolvedValue(thread());

      const rejection = await rejectionOf(service.getThread('u-ghost', 't1'));

      expect(rejection?.getStatus()).toBe(404);
    });
  });

  describe('close', () => {
    it('closes an active thread once, audits, and tells both sides', async () => {
      prisma.chatThread.findUnique.mockResolvedValue({
        id: 't1',
        status: 'ACTIVE',
        student: { userId: 'u-student' },
        professional: { userId: 'u-pro' },
      });

      const result = await service.close('u-student', 't1');

      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'CLOSED', closedAt: expect.any(Date) },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'chat.thread_closed' }),
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-student',
        REALTIME_EVENTS.CHAT_THREAD_CLOSED,
        { threadId: 't1' },
      );
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'u-pro',
        REALTIME_EVENTS.CHAT_THREAD_CLOSED,
        { threadId: 't1' },
      );
      expect(result).toEqual({ id: 't1', status: 'CLOSED' });
    });

    it('is idempotent: an already-CLOSED thread gets no writes or emits', async () => {
      prisma.chatThread.findUnique.mockResolvedValue({
        id: 't1',
        status: 'CLOSED',
        student: { userId: 'u-student' },
        professional: { userId: 'u-pro' },
      });

      const result = await service.close('u-student', 't1');

      expect(result).toEqual({ id: 't1', status: 'CLOSED' });
      expect(prisma.chatThread.update).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
      expect(realtime.emitToUser).not.toHaveBeenCalled();
    });
  });

  describe('unreadSummary', () => {
    it('counts per thread excluding my own and SYSTEM rows, omitting zeros', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'STUDENT',
        studentProfile: { id: 's1' },
        professionalProfile: null,
      });
      prisma.chatThread.findMany.mockResolvedValue([
        { id: 't1', studentReadAt: new Date('2026-10-09T09:00:00Z') },
        { id: 't2', studentReadAt: null },
      ]);
      prisma.chatMessage.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0);

      const summary = await service.unreadSummary('u-student');

      expect(prisma.chatMessage.count).toHaveBeenCalledWith({
        where: {
          threadId: 't1',
          senderUserId: { not: 'u-student' },
          createdAt: { gt: new Date('2026-10-09T09:00:00Z') },
        },
      });
      expect(prisma.chatMessage.count).toHaveBeenCalledWith({
        where: { threadId: 't2', senderUserId: { not: 'u-student' } },
      });
      expect(summary).toEqual({ total: 5, byThread: { t1: 5 } });
    });

    it('staff count against their professional marker', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'COUNSELLOR',
        studentProfile: null,
        professionalProfile: { id: 'p1' },
      });
      prisma.chatThread.findMany.mockResolvedValue([
        { id: 't9', professionalReadAt: null },
      ]);
      prisma.chatMessage.count.mockResolvedValue(1);

      await service.unreadSummary('u-pro');

      expect(prisma.chatThread.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { professionalId: 'p1' } }),
      );
      expect(prisma.chatMessage.count).toHaveBeenCalledWith({
        where: { threadId: 't9', senderUserId: { not: 'u-pro' } },
      });
    });

    it('is empty for a user with neither profile', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'STUDENT',
        studentProfile: null,
        professionalProfile: null,
      });

      await expect(service.unreadSummary('u-new')).resolves.toEqual({
        total: 0,
        byThread: {},
      });
      expect(prisma.chatThread.findMany).not.toHaveBeenCalled();
    });
  });
});
