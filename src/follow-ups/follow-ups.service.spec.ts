import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import { ProfessionalsService } from '../professionals/professionals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FollowUpsService } from './follow-ups.service.js';

describe('FollowUpsService', () => {
  let service: FollowUpsService;
  let prisma: {
    studentProfile: Record<string, ReturnType<typeof vi.fn>>;
    professionalProfile: Record<string, ReturnType<typeof vi.fn>>;
    followUp: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  const professional = { id: 'pro-1', userId: 'staff-1' };

  beforeEach(async () => {
    prisma = {
      studentProfile: { findUnique: vi.fn() },
      professionalProfile: { findUnique: vi.fn() },
      followUp: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      supportRequest: { findUnique: vi.fn() },
    };
    audit = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FollowUpsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        {
          provide: ProfessionalsService,
          useValue: {
            ensureProfile: vi.fn().mockResolvedValue(professional),
          },
        },
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
    expect(result).toHaveLength(1);
  });

  it('returns follow-ups for a professional profile', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue(null);
    prisma.professionalProfile.findUnique.mockResolvedValue({ id: 'pro-1' });
    prisma.followUp.findMany.mockResolvedValue([{ id: 'fu-1' }]);

    const result = await service.listForUser('user-1');
    expect(result).toHaveLength(1);
  });

  it('returns an empty list when the user has neither profile', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue(null);
    prisma.professionalProfile.findUnique.mockResolvedValue(null);

    const result = await service.listForUser('user-1');
    expect(result).toEqual([]);
  });

  it('creates a PENDING follow-up owned by the caller professional', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({ id: 'student-1' });
    prisma.followUp.create.mockResolvedValue({ id: 'fu-new', status: 'PENDING' });

    const result = await service.create('staff-1', {
      studentId: 'student-1',
      supportRequestId: undefined,
      notes: 'Check in after therapy',
      dueAt: undefined,
    } as never);

    expect(prisma.followUp.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studentId: 'student-1',
        professionalId: 'pro-1',
        status: 'PENDING',
        notes: 'Check in after therapy',
      }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'follow_up.created' }),
    );
    expect(result.id).toBe('fu-new');
  });

  it('throws when the target student profile does not exist', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.create('staff-1', { studentId: 'nope' } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws when the referenced support request does not exist', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({ id: 'student-1' });
    prisma.supportRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.create('staff-1', {
        studentId: 'student-1',
        supportRequestId: 'missing-req',
      } as never),
    ).rejects.toThrow(NotFoundException);
  });

  it('updates own follow-up and stamps completion', async () => {
    prisma.followUp.findUnique.mockResolvedValue({
      id: 'fu-1',
      professionalId: 'pro-1',
      status: 'PENDING',
    });
    prisma.followUp.update.mockResolvedValue({
      id: 'fu-1',
      status: 'COMPLETED',
    });

    const result = await service.update('staff-1', 'fu-1', {
      status: 'COMPLETED',
      notes: 'Had a good session',
    });

    expect(prisma.followUp.update).toHaveBeenCalledWith({
      where: { id: 'fu-1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        notes: 'Had a good session',
        completedAt: expect.any(Date),
      }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'follow_up.updated' }),
    );
    expect(result.status).toBe('COMPLETED');
  });

  it('forbids updating another professional follow-up', async () => {
    prisma.followUp.findUnique.mockResolvedValue({
      id: 'fu-1',
      professionalId: 'pro-OTHER',
      status: 'PENDING',
    });
    await expect(
      service.update('staff-1', 'fu-1', { status: 'CANCELLED' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws for a missing follow-up', async () => {
    prisma.followUp.findUnique.mockResolvedValue(null);
    await expect(
      service.update('staff-1', 'missing', { status: 'CANCELLED' }),
    ).rejects.toThrow(NotFoundException);
  });
});
