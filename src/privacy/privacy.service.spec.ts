import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { StudentsService } from '../students/students.service.js';
import { PrivacyService } from './privacy.service.js';

describe('PrivacyService', () => {
  let service: PrivacyService;
  let prisma: {
    privacyPreference: Record<string, ReturnType<typeof vi.fn>>;
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
      privacyPreference: { upsert: vi.fn() },
    };
    audit = { log: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrivacyService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(PrivacyService);
  });

  it('returns the upserted preference for the student', async () => {
    prisma.privacyPreference.upsert.mockResolvedValue({
      id: 'pref-1',
      studentId: student.id,
    });
    const result = await service.get('user-1');
    expect(prisma.privacyPreference.upsert).toHaveBeenCalledWith({
      where: { studentId: student.id },
      create: { studentId: student.id },
      update: {},
    });
    expect(result.studentId).toBe(student.id);
  });

  it('only updates the fields actually sent on a partial update', async () => {
    prisma.privacyPreference.upsert.mockResolvedValue({ id: 'pref-1' });

    await service.update('user-1', { shareAiCopingHubNotes: true });

    const call = prisma.privacyPreference.upsert.mock.calls[0][0];
    // update clause must NOT reset the other prefs to false
    expect(call.update).toEqual({ shareAiCopingHubNotes: true });
    expect(call.update.allowParentGuardianNotification).toBeUndefined();
    expect(call.update.requestPeerSupportCompanion).toBeUndefined();
  });

  it('creates with defaults on first update and audits the action', async () => {
    prisma.privacyPreference.upsert.mockResolvedValue({
      id: 'pref-1',
      requestPeerSupportCompanion: true,
    });

    await service.update('user-1', { requestPeerSupportCompanion: true });

    const call = prisma.privacyPreference.upsert.mock.calls[0][0];
    expect(call.create).toEqual({
      studentId: student.id,
      shareAiCopingHubNotes: false,
      allowParentGuardianNotification: false,
      requestPeerSupportCompanion: true,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'privacy.updated' }),
    );
  });
});