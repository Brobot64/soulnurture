import { Test, TestingModule } from '@nestjs/testing';
import type { SupportFlag } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ACUTE_FLAG_NOTIFICATION_TYPE,
  SupportFlagAlertsService,
} from './support-flag-alerts.service.js';

const flag = (overrides: Partial<SupportFlag> = {}): SupportFlag => ({
  id: 'flag-1',
  studentId: 'student-1',
  conversationId: 'conv-1',
  assigneeId: null,
  studentRef: 'GSS/2026/0142',
  classLabel: 'Year 10',
  triggerLabel: 'Possible suicidal intent',
  category: 'SUICIDAL_IDEATION',
  intentId: 'SUICIDAL_IDEATION',
  severity: 'TIER_3_ACUTE',
  status: 'OPEN',
  source: 'SERVER_POLICY',
  aiContextSummary: null,
  autoActions: ['SUPPORT_FLAG'],
  createdAt: new Date('2026-10-11T09:00:00Z'),
  resolvedAt: null,
  updatedAt: new Date('2026-10-11T09:00:00Z'),
  ...overrides,
});

describe('SupportFlagAlertsService', () => {
  let service: SupportFlagAlertsService;
  let prisma: {
    studentProfile: Record<string, ReturnType<typeof vi.fn>>;
    user: Record<string, ReturnType<typeof vi.fn>>;
    supportPerson: Record<string, ReturnType<typeof vi.fn>>;
    supportRequest: Record<string, ReturnType<typeof vi.fn>>;
  };
  let notifications: { pushMany: ReturnType<typeof vi.fn> };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      studentProfile: { findUnique: vi.fn() },
      user: { findMany: vi.fn() },
      supportPerson: { findFirst: vi.fn() },
      supportRequest: { create: vi.fn().mockResolvedValue({ id: 'request-1' }) },
    };
    notifications = { pushMany: vi.fn().mockResolvedValue([]) };
    audit = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportFlagAlertsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(SupportFlagAlertsService);
  });

  it('notifies the school professionals in English with the verbatim quote and its language labelled', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'en',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    prisma.supportPerson.findFirst.mockResolvedValue({
      id: 'person-1',
      type: 'COUNSELLOR',
    });

    const note = await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'there is no reason to live here anymore',
      language: 'yo',
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        schoolId: 'school-1',
        deactivatedAt: null,
        role: { in: ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] },
      },
      select: { id: true },
    });
    expect(notifications.pushMany).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: ['u1', 'u2'],
        type: ACUTE_FLAG_NOTIFICATION_TYPE,
        title: expect.stringContaining('GSS/2026/0142'),
        body: expect.stringContaining(
          'there is no reason to live here anymore',
        ),
      }),
    );
    const payload = notifications.pushMany.mock.calls[0][0] as {
      title: string;
      body: string;
      data: Record<string, unknown>;
    };
    expect(payload.title).toContain('Immediate follow-up recommended');
    expect(payload.body).toContain('(yo)');
    expect(payload.data).toEqual(
      expect.objectContaining({
        flagId: 'flag-1',
        conversationId: 'conv-1',
        studentRef: 'GSS/2026/0142',
        severity: 'TIER_3_ACUTE',
        language: 'yo',
        schoolId: 'school-1',
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_flag.school_alerted',
        entityId: 'flag-1',
        meta: expect.objectContaining({ recipients: 2, language: 'yo' }),
      }),
    );
    expect(note).toContain('(2)');
  });

  it('queues a support request in the staff tray for the escalation', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'en',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    prisma.supportPerson.findFirst.mockResolvedValue({
      id: 'person-1',
      type: 'COUNSELLOR',
    });

    await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'there is no reason to live here anymore',
      language: 'ha',
    });

    expect(prisma.supportRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studentId: 'student-1',
        supportPersonId: 'person-1',
        personType: 'COUNSELLOR',
        timing: 'URGENT_UNSAFE',
        status: 'ESCALATED',
        conversationId: 'conv-1',
        note: expect.stringContaining(
          'there is no reason to live here anymore',
        ),
      }),
    });
  });

  it('skips the tray request when no active support person exists', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'en',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    prisma.supportPerson.findFirst.mockResolvedValue(null);

    await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'help me',
      language: 'en',
    });

    expect(prisma.supportRequest.create).not.toHaveBeenCalled();
  });

  it('falls back to the standing preference when no language is given', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'ha',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);
    prisma.supportPerson.findFirst.mockResolvedValue({
      id: 'person-1',
      type: 'COUNSELLOR',
    });

    await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'I do not want to be here anymore',
    });

    const payload = notifications.pushMany.mock.calls[0][0] as {
      title: string;
      data: Record<string, unknown>;
    };
    expect(payload.title).toContain('Immediate follow-up recommended');
    expect(payload.data.language).toBe('ha');
  });

  it('falls back to English for an unsupported standing preference', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'fr',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);

    await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'I do not want to be here anymore',
    });

    const payload = notifications.pushMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(payload.data.language).toBe('en');
  });

  it('alerts nobody but still audits when the student has no school', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'en',
      user: { schoolId: null },
    });

    const note = await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'help me',
      language: 'en',
    });

    expect(notifications.pushMany).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_flag.school_alerted',
        meta: expect.objectContaining({ recipients: 0, schoolId: null }),
      }),
    );
    expect(note).toContain('no school professionals');
  });

  it('alerts nobody but still audits when the school has no active professionals', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      preferredLanguage: 'en',
      user: { schoolId: 'school-1' },
    });
    prisma.user.findMany.mockResolvedValue([]);

    const note = await service.recommendImmediateFollowUp({
      flag: flag(),
      studentMessage: 'help me',
      language: 'en',
    });

    expect(notifications.pushMany).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ recipients: 0 }),
      }),
    );
    expect(note).toContain('no school professionals');
  });
});
