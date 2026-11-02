import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  SupportFlagReviewDecision,
  SupportFlagStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupportFlagsService } from './support-flags.service.js';

const SCHOOL = { student: { user: { schoolId: 'school-1' } } };

const ALL_LEVELS = { A: 0, B: 0, C: 0, U: 0, UNCLASSIFIED: 0 };

function flagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    status: SupportFlagStatus.OPEN,
    severity: 'TIER_2_HIGH',
    level: null,
    source: 'AI_CATEGORY',
    category: 'anxiety',
    intentId: null,
    autoActions: [],
    createdAt: new Date('2026-11-02T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    resolvedAt: null,
    conversationId: 'conv-1',
    ruleId: null,
    ruleVersion: null,
    reviewDecision: null,
    studentStatementSnapshot: 'I can’t stop shaking before exams',
    triggerLabel: 'exam stress',
    aiContextSummary: 'Student describes physical anxiety before exams.',
    studentRef: 'SS-1042',
    classLabel: 'SS2 B',
    ...overrides,
  };
}

describe('SupportFlagsService', () => {
  let service: SupportFlagsService;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn> };
    conversation: { findMany: ReturnType<typeof vi.fn> };
    supportFlag: Record<string, ReturnType<typeof vi.fn>>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ schoolId: 'school-1' }) },
      conversation: { findMany: vi.fn() },
      supportFlag: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn(),
        groupBy: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
    };
    audit = { log: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportFlagsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(SupportFlagsService);
  });

  it("lists the actor school's flags and counts open ones school-wide", async () => {
    prisma.supportFlag.findMany.mockResolvedValue([{ id: 'f1' }]);
    prisma.supportFlag.count.mockResolvedValue(2);

    const result = await service.list('user-1', {
      severity: 'TIER_2_HIGH',
      status: 'OPEN',
    });

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith({
      where: { ...SCHOOL, severity: 'TIER_2_HIGH', status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(prisma.supportFlag.count).toHaveBeenCalledWith({
      where: {
        ...SCHOOL,
        status: { in: [SupportFlagStatus.OPEN, SupportFlagStatus.IN_REVIEW] },
      },
    });
    expect(result.openCount).toBe(2);
  });

  it('lists every school flag when no filter is set, still tenant-scoped', async () => {
    await service.list('user-1', {});

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...SCHOOL } }),
    );
  });

  it('makes each level chip count the exact set that chip filters', async () => {
    // The queue rule: a Level B chip saying 3 must return those same 3 rows, so
    // the count is taken over the scope *without* the level the chip selects.
    prisma.supportFlag.groupBy.mockResolvedValue([
      { level: 'B', _count: { _all: 3 } },
      { level: 'U', _count: { _all: 1 } },
      { level: null, _count: { _all: 4 } },
    ]);

    const result = await service.list('user-1', {
      severity: 'TIER_2_HIGH',
      level: 'B',
    });

    expect(prisma.supportFlag.groupBy).toHaveBeenCalledWith({
      by: ['level'],
      where: { ...SCHOOL, severity: 'TIER_2_HIGH' },
      _count: { _all: true },
    });
    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...SCHOOL, severity: 'TIER_2_HIGH', level: 'B' },
      }),
    );
    expect(result.levelCounts).toEqual({
      ...ALL_LEVELS,
      B: 3,
      U: 1,
      UNCLASSIFIED: 4,
    });
  });

  it('reads UNCLASSIFIED as a real bucket, not as an absent level filter', async () => {
    // An unclassified flag is one no approved rule graded, which a reviewer must
    // be able to find; dropping `level: null` would hide the backlog.
    await service.list('user-1', { level: 'UNCLASSIFIED' });

    expect(prisma.supportFlag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...SCHOOL, level: null } }),
    );
  });

  it('rejects an unknown level before reading any flag', async () => {
    await expect(service.list('user-1', { level: 'D' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    expect(prisma.supportFlag.groupBy).not.toHaveBeenCalled();
  });

  it('shows nothing and queries no tenant data for an actor without a school', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    const result = await service.list('orphan-1', {});

    expect(result).toEqual({
      items: [],
      openCount: 0,
      levelCounts: ALL_LEVELS,
    });
    expect(prisma.supportFlag.findMany).not.toHaveBeenCalled();
    expect(prisma.supportFlag.groupBy).not.toHaveBeenCalled();
    expect(prisma.supportFlag.count).not.toHaveBeenCalled();
  });

  it('acknowledges a flag the school owns and audits the status transition', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue(flagRow());
    prisma.supportFlag.update.mockResolvedValue(flagRow());

    const result = await service.acknowledge('user-1', 'f1');

    expect(prisma.supportFlag.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'f1', ...SCHOOL } }),
    );
    expect(prisma.supportFlag.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: SupportFlagStatus.ACKNOWLEDGED },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_flag.acknowledged',
        priorStatus: SupportFlagStatus.OPEN,
        newStatus: SupportFlagStatus.ACKNOWLEDGED,
      }),
    );
    expect(result.message).toBe('Flag acknowledged');
  });

  it('marks a flag in-review and audits the action', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue(flagRow());
    prisma.supportFlag.update.mockResolvedValue(flagRow());

    const result = await service.markInReview('user-1', 'f1');

    expect(prisma.supportFlag.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { status: SupportFlagStatus.IN_REVIEW },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_flag.in_review',
        priorStatus: SupportFlagStatus.OPEN,
        newStatus: SupportFlagStatus.IN_REVIEW,
      }),
    );
    expect(result.message).toBe('Flag marked in-review');
  });

  it('throws NotFoundException for an unknown flag', async () => {
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    await expect(service.acknowledge('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it("refuses to touch another school's flag without confirming it exists", async () => {
    // Tenant-scoped lookup finds nothing for a foreign id, so the caller
    // cannot tell a rival school's flag apart from a row that never was.
    prisma.supportFlag.findFirst.mockResolvedValue(null);
    prisma.supportFlag.findUnique.mockResolvedValue({ id: 'f9', schoolId: 'other' });

    await expect(service.markInReview('user-1', 'f9')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.supportFlag.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('refuses flag writes for an actor without a school', async () => {
    prisma.user.findUnique.mockResolvedValue({ schoolId: null });

    await expect(service.acknowledge('orphan-1', 'f1')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.supportFlag.findFirst).not.toHaveBeenCalled();
    expect(prisma.supportFlag.update).not.toHaveBeenCalled();
  });

  describe('detail', () => {
    it('keeps the four kinds of content apart and reads nothing from live chat', async () => {
      // US-D02: the student line shown to the reviewer is the one frozen when
      // the flag was raised, so a later edited conversation cannot rewrite it.
      prisma.supportFlag.findFirst.mockResolvedValue(flagRow());

      const result = await service.detail('user-1', 'f1');

      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
      expect(result.studentReported).toEqual({
        statement: 'I can’t stop shaking before exams',
        triggerLabel: 'exam stress',
      });
      expect(result.aiSummary).toBe(
        'Student describes physical anxiety before exams.',
      );
      expect(result.student).toEqual({ ref: 'SS-1042', classLabel: 'SS2 B' });
      expect(result.systemMetadata.status).toBe(SupportFlagStatus.OPEN);
    });

    it('keeps level and severity as two axes and names the rule behind them', async () => {
      prisma.supportFlag.findFirst.mockResolvedValue(
        flagRow({ level: 'U', severity: 'TIER_3_ACUTE', ruleId: 'IND-U01' }),
      );

      const result = await service.detail('user-1', 'f1');

      // Unclear evidence (U) is reported as U, never softened into a milder
      // level, and never inferred from the alert severity beside it.
      expect(result.systemMetadata.level).toBe('U');
      expect(result.systemMetadata.severity).toBe('TIER_3_ACUTE');
      expect(result.systemMetadata.ruleLabel).toBeNull();
      expect(result.systemMetadata.ruleConfigured).toBe(false);
      expect(result.systemMetadata.ruleBlockedOn).toContain('CP-09');
    });

    it('quotes the reviewed label when a rule has one', async () => {
      prisma.supportFlag.findFirst.mockResolvedValue(
        flagRow({ level: 'B', ruleId: 'IND-B01', ruleVersion: '1' }),
      );

      const result = await service.detail('user-1', 'f1');

      expect(result.systemMetadata.ruleLabel).toBe('distress recurring/persistent');
      expect(result.systemMetadata.ruleId).toBe('IND-B01');
    });

    it('offers exactly the three recorded decisions, and no fourth way out', async () => {
      prisma.supportFlag.findFirst.mockResolvedValue(flagRow());

      const result = await service.detail('user-1', 'f1');

      expect(result.humanDecision.decisions).toEqual([
        SupportFlagReviewDecision.NO_FURTHER_ACTION,
        SupportFlagReviewDecision.FOLLOW_UP_WITH_STUDENT,
        SupportFlagReviewDecision.FOLLOW_SAFEGUARDING_PROCEDURE,
      ]);
      expect(result.humanDecision.reviewDecision).toBeNull();
    });

    it('does not confirm a foreign flag id exists', async () => {
      prisma.supportFlag.findFirst.mockResolvedValue(null);

      await expect(service.detail('user-1', 'f9')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('review decision', () => {
    it('records the decision without moving the workflow status', async () => {
      // G4: a decision is a separate fact from progress, so the update payload
      // must not gain a status key and the audit must show an unchanged state.
      prisma.supportFlag.findFirst.mockResolvedValue(flagRow());
      prisma.supportFlag.update.mockResolvedValue(flagRow());

      const result = await service.recordReviewDecision(
        'user-1',
        'f1',
        SupportFlagReviewDecision.FOLLOW_SAFEGUARDING_PROCEDURE,
      );

      const data = prisma.supportFlag.update.mock.calls[0][0].data;
      expect(data).toEqual({
        reviewDecision: 'FOLLOW_SAFEGUARDING_PROCEDURE',
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'support_flag.review_decision',
          priorStatus: SupportFlagStatus.OPEN,
          newStatus: SupportFlagStatus.OPEN,
        }),
      );
      expect(result.message).toBe('Review decision recorded');
    });

    it("refuses another school's flag and writes nothing", async () => {
      prisma.supportFlag.findFirst.mockResolvedValue(null);

      await expect(
        service.recordReviewDecision(
          'user-1',
          'f9',
          SupportFlagReviewDecision.NO_FURTHER_ACTION,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.supportFlag.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses to record a decision for an actor without a school', async () => {
      prisma.user.findUnique.mockResolvedValue({ schoolId: null });

      await expect(
        service.recordReviewDecision(
          'orphan-1',
          'f1',
          SupportFlagReviewDecision.NO_FURTHER_ACTION,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.supportFlag.findFirst).not.toHaveBeenCalled();
    });
  });
});
