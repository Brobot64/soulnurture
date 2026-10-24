import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { validate } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { ProfessionalsService } from '../professionals/professionals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateFollowUpDto } from './dto/follow-up.dto.js';
import { FollowUpsService } from './follow-ups.service.js';

describe('FollowUpsService', () => {
  let service: FollowUpsService;
  let prisma: {
    studentProfile: Record<string, ReturnType<typeof vi.fn>>;
    professionalProfile: Record<string, ReturnType<typeof vi.fn>>;
    followUp: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let professionals: { ensureProfile: ReturnType<typeof vi.fn> };

  const professional = { id: 'pro-1', userId: 'staff-1' };

  beforeEach(async () => {
    prisma = {
      studentProfile: { findUnique: vi.fn(), findFirst: vi.fn() },
      professionalProfile: { findUnique: vi.fn() },
      followUp: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      supportRequest: { findFirst: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue({ schoolId: 'school-1' }) },
    };
    audit = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
    professionals = { ensureProfile: vi.fn().mockResolvedValue(professional) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FollowUpsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ProfessionalsService, useValue: professionals },
      ],
    }).compile();

    service = module.get(FollowUpsService);
  });

  it('returns follow-ups for a student by their profile', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({ id: 'student-1' });
    prisma.followUp.findMany.mockResolvedValue([{ id: 'fu-1' }]);

    const result = await service.listForUser('user-1');

    expect(prisma.followUp.findMany).toHaveBeenCalledWith({
      where: { studentId: 'student-1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'fu-1' }]);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns only owned follow-ups whose student is in the current school', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue(null);
    prisma.professionalProfile.findUnique.mockResolvedValue({ id: 'pro-1' });
    prisma.followUp.findMany.mockResolvedValue([{ id: 'fu-1' }]);

    const result = await service.listForUser('staff-1');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      select: { schoolId: true },
    });
    expect(prisma.followUp.findMany).toHaveBeenCalledWith({
      where: {
        professionalId: 'pro-1',
        student: { user: { schoolId: 'school-1' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([{ id: 'fu-1' }]);
    expect(professionals.ensureProfile).not.toHaveBeenCalled();
  });

  it.each([null, { schoolId: null }])(
    'returns no professional follow-ups without a current school (%j)',
    async (user) => {
      prisma.studentProfile.findUnique.mockResolvedValue(null);
      prisma.professionalProfile.findUnique.mockResolvedValue(professional);
      prisma.user.findUnique.mockResolvedValue(user);

      expect(await service.listForUser('staff-1')).toEqual([]);
      expect(prisma.followUp.findMany).not.toHaveBeenCalled();
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
    },
  );

  it('returns an empty list when the user has neither profile', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue(null);
    prisma.professionalProfile.findUnique.mockResolvedValue(null);

    const result = await service.listForUser('user-1');
    expect(result).toEqual([]);
  });

  it('creates a PENDING follow-up for a same-school student owned by the caller', async () => {
    prisma.studentProfile.findFirst.mockResolvedValue({ id: 'student-1' });
    prisma.followUp.create.mockResolvedValue({ id: 'fu-new', status: 'PENDING' });

    const result = await service.create('staff-1', {
      studentId: 'student-1',
      notes: 'Check in after therapy',
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'staff-1' },
      select: { schoolId: true },
    });
    expect(prisma.studentProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'student-1', user: { schoolId: 'school-1' } },
      select: { id: true },
    });
    expect(professionals.ensureProfile).toHaveBeenCalledWith('staff-1');
    expect(prisma.supportRequest.findFirst).not.toHaveBeenCalled();
    expect(prisma.followUp.create).toHaveBeenCalledWith({
      data: {
        studentId: 'student-1',
        professionalId: 'pro-1',
        supportRequestId: undefined,
        status: 'PENDING',
        notes: 'Check in after therapy',
        dueAt: null,
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'follow_up.created', schoolId: 'school-1' }),
    );
    expect(result.id).toBe('fu-new');
  });

  it.each(['PENDING', 'SCHEDULED'] as const)(
    'creates an explicitly %s follow-up with a due date',
    async (status) => {
      prisma.studentProfile.findFirst.mockResolvedValue({ id: 'student-1' });
      prisma.followUp.create.mockResolvedValue({ id: 'fu-new', status });
      const dueAt = '2026-10-25T10:00:00Z';

      const result = await service.create('staff-1', {
        studentId: 'student-1', status, dueAt,
      });

      expect(prisma.followUp.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status, dueAt: new Date(dueAt) }),
      });
      expect(result.status).toBe(status);
    },
  );

  it('rejects scheduling without a due date before creating a profile or writing', async () => {
    prisma.studentProfile.findFirst.mockResolvedValue({ id: 'student-1' });

    await expect(service.create('staff-1', {
      studentId: 'student-1', status: 'SCHEDULED',
    })).rejects.toThrow(BadRequestException);

    expect(professionals.ensureProfile).not.toHaveBeenCalled();
    expect(prisma.followUp.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('links only a request for the selected student in the same school', async () => {
    prisma.studentProfile.findFirst.mockResolvedValue({ id: 'student-1' });
    prisma.supportRequest.findFirst.mockResolvedValue({ id: 'req-1' });
    prisma.followUp.create.mockResolvedValue({ id: 'fu-new', status: 'PENDING' });

    await service.create('staff-1', {
      studentId: 'student-1',
      supportRequestId: 'req-1',
      dueAt: '2026-10-25T10:00:00Z',
    });

    expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'req-1',
        studentId: 'student-1',
        student: { user: { schoolId: 'school-1' } },
      },
      select: { id: true },
    });
    expect(prisma.followUp.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studentId: 'student-1',
        professionalId: 'pro-1',
        supportRequestId: 'req-1',
        status: 'PENDING',
        dueAt: new Date('2026-10-25T10:00:00Z'),
      }),
    });
  });

  it.each([
    ['missing account', null],
    ['school-less account', { schoolId: null }],
  ])('rejects a %s before any tenant lookup or write', async (_label, user) => {
    prisma.user.findUnique.mockResolvedValue(user);

    await expect(
      service.create('staff-1', { studentId: 'student-1', supportRequestId: 'req-1' }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.studentProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportRequest.findFirst).not.toHaveBeenCalled();
    expect(professionals.ensureProfile).not.toHaveBeenCalled();
    expect(prisma.followUp.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each(['missing-student', 'other-school-student'])(
    'rejects %s without creating a profile, follow-up or audit',
    async (studentId) => {
      prisma.studentProfile.findFirst.mockResolvedValue(null);

      await expect(
        service.create('staff-1', { studentId, supportRequestId: 'req-1' }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.studentProfile.findFirst).toHaveBeenCalledWith({
        where: { id: studentId, user: { schoolId: 'school-1' } },
        select: { id: true },
      });
      expect(prisma.supportRequest.findFirst).not.toHaveBeenCalled();
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
      expect(prisma.followUp.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(['missing-request', 'other-school-request', 'other-student-request'])(
    'rejects %s without creating a profile, follow-up or audit',
    async (supportRequestId) => {
      prisma.studentProfile.findFirst.mockResolvedValue({ id: 'student-1' });
      prisma.supportRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.create('staff-1', { studentId: 'student-1', supportRequestId }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.supportRequest.findFirst).toHaveBeenCalledWith({
        where: {
          id: supportRequestId,
          studentId: 'student-1',
          student: { user: { schoolId: 'school-1' } },
        },
        select: { id: true },
      });
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
      expect(prisma.followUp.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('updates own same-school follow-up, stamps completion and audits the school', async () => {
    prisma.followUp.findFirst.mockResolvedValue({
      id: 'fu-1',
      professional,
      status: 'PENDING',
      dueAt: null,
    });
    const updated = { id: 'fu-1', status: 'COMPLETED' };
    prisma.followUp.update.mockResolvedValue(updated);

    const result = await service.update('staff-1', 'fu-1', {
      status: 'COMPLETED',
      notes: 'Had a good session',
    });

    expect(prisma.followUp.findFirst).toHaveBeenCalledWith({
      where: { id: 'fu-1', student: { user: { schoolId: 'school-1' } } },
      include: { professional: { select: { userId: true } } },
    });
    expect(prisma.followUp.update).toHaveBeenCalledWith({
      where: { id: 'fu-1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        notes: 'Had a good session',
        completedAt: expect.any(Date),
      }),
    });
    expect(audit.log).toHaveBeenCalledWith({
      actorId: 'staff-1',
      action: 'follow_up.updated',
      entity: 'FollowUp',
      entityId: 'fu-1',
      meta: { status: 'COMPLETED' },
      schoolId: 'school-1',
    });
    expect(professionals.ensureProfile).not.toHaveBeenCalled();
    expect(result).toEqual(updated);
    expect(result).not.toHaveProperty('professional');
  });

  it.each([null, { userId: 'other-staff' }])(
    'forbids same-school updates by a nonowner (%j) without writes',
    async (owner) => {
      prisma.followUp.findFirst.mockResolvedValue({
        id: 'fu-1', professional: owner, status: 'PENDING', dueAt: null,
      });

      await expect(
        service.update('staff-1', 'fu-1', { status: 'SCHEDULED' }),
      ).rejects.toThrow(ForbiddenException);

      expect(professionals.ensureProfile).not.toHaveBeenCalled();
      expect(prisma.followUp.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'other-school-follow-up'])(
    'returns 404 for %s using a scoped lookup without writes',
    async (id) => {
      prisma.followUp.findFirst.mockResolvedValue(null);

      await expect(
        service.update('staff-1', id, { status: 'SCHEDULED' }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.followUp.findFirst).toHaveBeenCalledWith({
        where: { id, student: { user: { schoolId: 'school-1' } } },
        include: { professional: { select: { userId: true } } },
      });
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
      expect(prisma.followUp.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each([null, { schoolId: null }])(
    'returns 404 for updates without a current school (%j) before lookup or writes',
    async (user) => {
      prisma.user.findUnique.mockResolvedValue(user);

      await expect(
        service.update('staff-1', 'fu-1', { status: 'SCHEDULED' }),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.followUp.findFirst).not.toHaveBeenCalled();
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
      expect(prisma.followUp.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    { existingStatus: 'PENDING', dto: { status: 'SCHEDULED' as const } },
    { existingStatus: 'SCHEDULED', dto: { notes: 'No date yet' } },
  ])('rejects a resulting SCHEDULED follow-up without an effective due date (%j)', async ({ existingStatus, dto }) => {
    prisma.followUp.findFirst.mockResolvedValue({
      id: 'fu-1', professional, status: existingStatus, dueAt: null,
    });

    await expect(service.update('staff-1', 'fu-1', dto)).rejects.toThrow(BadRequestException);

    expect(professionals.ensureProfile).not.toHaveBeenCalled();
    expect(prisma.followUp.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    { existingStatus: 'PENDING', existingDueAt: null, dto: { status: 'SCHEDULED' as const, dueAt: '2026-10-25T10:00:00Z' } },
    { existingStatus: 'PENDING', existingDueAt: new Date('2026-10-24T10:00:00Z'), dto: { status: 'SCHEDULED' as const } },
    { existingStatus: 'SCHEDULED', existingDueAt: new Date('2026-10-24T10:00:00Z'), dto: { dueAt: '2026-10-25T10:00:00Z' } },
    { existingStatus: 'SCHEDULED', existingDueAt: new Date('2026-10-24T10:00:00Z'), dto: { notes: 'Same appointment' } },
    { existingStatus: 'SCHEDULED', existingDueAt: null, dto: { dueAt: '2026-10-25T10:00:00Z' } },
  ])('accepts scheduling with a new or existing effective due date (%j)', async ({ existingStatus, existingDueAt, dto }) => {
    prisma.followUp.findFirst.mockResolvedValue({
      id: 'fu-1', professional, status: existingStatus, dueAt: existingDueAt,
    });
    prisma.followUp.update.mockResolvedValue({ id: 'fu-1', status: 'SCHEDULED' });

    await service.update('staff-1', 'fu-1', dto);

    expect(prisma.followUp.update).toHaveBeenCalledWith({
      where: { id: 'fu-1' },
      data: {
        status: dto.status,
        notes: dto.notes,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        completedAt: undefined,
      },
    });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      meta: { status: 'SCHEDULED' }, schoolId: 'school-1',
    }));
    expect(professionals.ensureProfile).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'CANCELLED', 'COMPLETED'] as const)(
    'does not require a due date when leaving SCHEDULED for %s',
    async (status) => {
      prisma.followUp.findFirst.mockResolvedValue({
        id: 'fu-1', professional, status: 'SCHEDULED', dueAt: null,
      });
      prisma.followUp.update.mockResolvedValue({ id: 'fu-1', status });

      expect((await service.update('staff-1', 'fu-1', { status })).status).toBe(status);
      expect(professionals.ensureProfile).not.toHaveBeenCalled();
    },
  );
});

describe('CreateFollowUpDto', () => {
  const studentId = '00000000-0000-4000-8000-000000000001';

  it.each([undefined, 'PENDING', 'SCHEDULED'])(
    'accepts the optional initial status %s',
    async (status) => {
      const dto = Object.assign(new CreateFollowUpDto(), { studentId, status });
      expect(await validate(dto)).toEqual([]);
    },
  );

  it.each(['COMPLETED', 'CANCELLED', 'UNKNOWN'])(
    'rejects initial status %s',
    async (status) => {
      const dto = Object.assign(new CreateFollowUpDto(), { studentId, status });
      expect(await validate(dto)).toEqual([
        expect.objectContaining({ property: 'status', constraints: { isIn: expect.any(String) } }),
      ]);
    },
  );
});
