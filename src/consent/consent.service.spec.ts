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
});