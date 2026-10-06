import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SupportRequestStatus, SupportTiming } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { SupportRequestsService } from './support-requests.service.js';

describe('SupportRequestsService', () => {
  let service: SupportRequestsService;
  let prisma: {
    supportPerson: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    prisma = {
      supportPerson: { findMany: vi.fn(), findFirst: vi.fn() },
      supportRequest: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    };
    audit = { log: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportRequestsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(SupportRequestsService);
  });

  it('lists only active support people', async () => {
    prisma.supportPerson.findMany.mockResolvedValue([
      { id: 'p1', name: 'Mrs. Adebayo', active: true },
    ]);
    const result = await service.listPeople();
    expect(prisma.supportPerson.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('throws NotFoundException when the support person is not available', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue(null);
    await expect(
      service.create('user-1', {
        supportPersonId: 'p1',
        personType: 'COUNSELLOR',
        timing: SupportTiming.GENTLE_1_2_DAYS,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('escalates an urgent/unsafe request and audits it', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue({ id: 'p1', active: true });
    prisma.supportRequest.create.mockResolvedValue({
      id: 'req-1',
      studentId: student.id,
      supportPerson: { id: 'p1' },
      status: SupportRequestStatus.ESCALATED,
    });

    const result = await service.create('user-1', {
      supportPersonId: 'p1',
      personType: 'COUNSELLOR',
      timing: SupportTiming.URGENT_UNSAFE,
      note: 'I am not safe',
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: SupportRequestStatus.ESCALATED }),
      include: { supportPerson: true },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_request.created' }),
    );
    expect(result.status).toBe(SupportRequestStatus.ESCALATED);
  });

  it('creates a gentle request as PENDING', async () => {
    prisma.supportPerson.findFirst.mockResolvedValue({ id: 'p1', active: true });
    prisma.supportRequest.create.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.PENDING,
    });

    await service.create('user-1', {
      supportPersonId: 'p1',
      personType: 'TRUSTED_TEACHER',
      timing: SupportTiming.GENTLE_1_2_DAYS,
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: SupportRequestStatus.PENDING }),
      include: { supportPerson: true },
    });
  });

  it('forbids reading another students request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      studentId: 'student-2',
      supportPerson: { id: 'p1' },
    });
    await expect(service.getOne('user-1', 'req-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws NotFoundException for a missing request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue(null);
    await expect(service.getOne('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('professional review sets status plus review note and audits the change', async () => {
    prisma.supportRequest.findUnique
      .mockResolvedValueOnce({ id: 'req-1', status: 'PENDING', reviewNote: null })
      .mockResolvedValueOnce({ id: 'req-1', status: 'PENDING', reviewNote: null });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Seen this afternoon',
      supportPerson: { id: 'p1' },
    });

    const result = await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.ACCEPTED,
      reviewNote: 'Seen this afternoon',
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: {
        status: SupportRequestStatus.ACCEPTED,
        reviewNote: 'Seen this afternoon',
      },
      include: { supportPerson: true },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_request.status_changed',
        entityId: 'req-1',
      }),
    );
    expect(result.status).toBe(SupportRequestStatus.ACCEPTED);
  });

  it('keeps the existing review note when the PATCH omits one', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      status: 'PENDING',
      reviewNote: 'called yesterday',
    });
    prisma.supportRequest.update.mockResolvedValue({
      id: 'req-1',
      status: 'SCHEDULED',
      reviewNote: 'called yesterday',
    });

    await service.review('staff-1', 'req-1', {
      status: SupportRequestStatus.SCHEDULED,
    });

    expect(prisma.supportRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: SupportRequestStatus.SCHEDULED,
          reviewNote: 'called yesterday',
        },
      }),
    );
  });

  it('throws for reviewing a missing request', async () => {
    prisma.supportRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.review('staff-1', 'missing', { status: SupportRequestStatus.ACCEPTED }),
    ).rejects.toThrow(NotFoundException);
  });
});