import { Test, TestingModule } from '@nestjs/testing';
import { StudentsService } from './students.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('StudentsService', () => {
  let auditService: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  });

  async function createModule(prisma: Record<string, unknown>) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    return module.get(StudentsService);
  }

  it('builds a greeting from student name', async () => {
    const prisma = {
      studentProfile: {
        findUnique: () =>
          Promise.resolve({ firstName: 'Amina', displayName: 'Amina' }),
      },
      emotionalCheckIn: { findFirst: () => Promise.resolve(null) },
    };
    const service = await createModule(prisma);
    const result = await service.getSanctuary('user-1');
    expect(result.greeting).toBe('Welcome back, Amina');
  });

  it('updateMe audits a preferredLanguage change with from/to', async () => {
    const prisma = {
      studentProfile: {
        findUnique: () =>
          Promise.resolve({
            id: 'sp-1',
            userId: 'user-1',
            firstName: 'Amina',
            preferredLanguage: 'en',
          }),
        update: () =>
          Promise.resolve({ id: 'sp-1', preferredLanguage: 'yo' }),
      },
    };
    const service = await createModule(prisma);

    await service.updateMe('user-1', { preferredLanguage: 'yo' });

    expect(auditService.log).toHaveBeenCalledWith({
      actorId: 'user-1',
      action: 'student.language_changed',
      entity: 'StudentProfile',
      entityId: 'sp-1',
      meta: { from: 'en', to: 'yo' },
    });
  });

  it('updateMe does not audit when the preference is unchanged', async () => {
    const prisma = {
      studentProfile: {
        findUnique: () =>
          Promise.resolve({
            id: 'sp-1',
            userId: 'user-1',
            firstName: 'Amina',
            preferredLanguage: 'en',
          }),
        update: () =>
          Promise.resolve({ id: 'sp-1', preferredLanguage: 'en' }),
      },
    };
    const service = await createModule(prisma);

    await service.updateMe('user-1', { preferredLanguage: 'en' });

    expect(auditService.log).not.toHaveBeenCalled();
  });
});
