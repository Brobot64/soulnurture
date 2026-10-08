import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { ConsentService } from './consent.service.js';

describe('ConsentService', () => {
  let service: ConsentService;
  let prisma: {
    consentRecord: Record<string, ReturnType<typeof vi.fn>>;
  };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    prisma = {
      consentRecord: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
      ],
    }).compile();

    service = module.get(ConsentService);
  });

  it('lists the students consent records', async () => {
    prisma.consentRecord.findMany.mockResolvedValue([
      { id: 'c1', version: 'v1', accepted: true },
    ]);
    const result = await service.listMine('user-1');
    expect(prisma.consentRecord.findMany).toHaveBeenCalledWith({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toHaveLength(1);
  });

  it('creates an accepted consent record on first accept', async () => {
    prisma.consentRecord.upsert.mockResolvedValue({
      id: 'c1',
      version: 'v1',
      accepted: true,
    });

    await service.accept('user-1', 'v1');

    expect(prisma.consentRecord.upsert).toHaveBeenCalledWith({
      where: { studentId_version: { studentId: student.id, version: 'v1' } },
      update: { accepted: true, acceptedAt: expect.any(Date) },
      create: {
        studentId: student.id,
        version: 'v1',
        accepted: true,
        acceptedAt: expect.any(Date),
      },
    });
  });

  it('uses the upsert unique key so re-accepting never duplicates', async () => {
    prisma.consentRecord.upsert.mockResolvedValue({ id: 'c1' });

    await service.accept('user-1', 'v1');
    await service.accept('user-1', 'v1');

    expect(prisma.consentRecord.upsert).toHaveBeenCalledTimes(2);
    for (const call of prisma.consentRecord.upsert.mock.calls) {
      expect(call[0].where).toEqual({
        studentId_version: { studentId: student.id, version: 'v1' },
      });
    }
  });

  it('records the agreements metadata alongside the acceptance for audit', async () => {
    prisma.consentRecord.upsert.mockResolvedValue({ id: 'c1' });
    const metadata = { disclosureVersion: 'v2', agreements: ['ai-limits'] };

    await service.accept('user-1', 'ai-disclosure-v2', metadata);

    expect(prisma.consentRecord.upsert).toHaveBeenCalledWith({
      where: {
        studentId_version: {
          studentId: student.id,
          version: 'ai-disclosure-v2',
        },
      },
      update: {
        accepted: true,
        acceptedAt: expect.any(Date),
        metadata,
      },
      create: {
        studentId: student.id,
        version: 'ai-disclosure-v2',
        accepted: true,
        acceptedAt: expect.any(Date),
        metadata,
      },
    });
  });

  it('reports an accepted status with the timestamp the client can show', async () => {
    const acceptedAt = new Date('2026-10-08T09:00:00.000Z');
    prisma.consentRecord.findUnique.mockResolvedValue({
      accepted: true,
      acceptedAt,
    });

    await expect(service.status('user-1', 'ai-disclosure-v2')).resolves.toEqual({
      version: 'ai-disclosure-v2',
      accepted: true,
      acceptedAt,
    });
  });

  it('treats a missing or withdrawn record as not accepted', async () => {
    prisma.consentRecord.findUnique.mockResolvedValue(null);
    await expect(service.status('user-1', 'ai-disclosure-v2')).resolves.toEqual({
      version: 'ai-disclosure-v2',
      accepted: false,
      acceptedAt: null,
    });
    await expect(
      service.hasAccepted('user-1', 'ai-disclosure-v2'),
    ).resolves.toBe(false);

    prisma.consentRecord.findUnique.mockResolvedValue({ accepted: false });
    await expect(
      service.hasAcceptedForStudent(student.id, 'ai-disclosure-v2'),
    ).resolves.toBe(false);
  });

  it('gates on the exact version so a bumped disclosure re-prompts', async () => {
    prisma.consentRecord.findUnique.mockResolvedValue({ accepted: true });

    await expect(
      service.hasAcceptedForStudent(student.id, 'ai-disclosure-v2'),
    ).resolves.toBe(true);

    expect(prisma.consentRecord.findUnique).toHaveBeenCalledWith({
      where: {
        studentId_version: {
          studentId: student.id,
          version: 'ai-disclosure-v2',
        },
      },
      select: { accepted: true },
    });
  });
});