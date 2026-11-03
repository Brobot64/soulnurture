import { ForbiddenException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ApprovalNamespace,
  ContentKind,
  ContentStatus,
  type ContentItem,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ContentService } from './content.service.js';

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: overrides.id ?? 'row-1',
    code: overrides.code ?? 'CP-05',
    kind: overrides.kind ?? ContentKind.CHECKIN_PROMPT,
    namespace: overrides.namespace ?? ApprovalNamespace.WELLBEING,
    status: overrides.status ?? ContentStatus.APPROVED_ACTIVE,
    majorVersion: 1,
    minorVersion: 0,
    patchVersion: 0,
    payload: {},
    ageBand: overrides.ageBand ?? null,
    locale: 'en',
    approvedBy: null,
    approvedAt: null,
    effectiveFrom: overrides.effectiveFrom ?? null,
    effectiveTo: overrides.effectiveTo ?? null,
    supersedesId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ContentService — the register gate (Doc C §6/§7)', () => {
  let service: ContentService;
  let prisma: { contentItem: { findMany: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    prisma = { contentItem: { findMany: vi.fn().mockResolvedValue([]) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ContentService);
  });

  it('returns nothing for an empty code list without hitting the database', async () => {
    const result = await service.resolve({
      kind: ContentKind.CHECKIN_PROMPT,
      codes: [],
    });
    expect(result).toEqual([]);
    expect(prisma.contentItem.findMany).not.toHaveBeenCalled();
  });

  it('resolves only APPROVED_ACTIVE rows', async () => {
    prisma.contentItem.findMany.mockResolvedValue([
      item({ code: 'CP-01', status: ContentStatus.APPROVED_ACTIVE }),
      item({ code: 'CP-02', status: ContentStatus.CONTENT_REVIEW_REQUIRED }),
      item({ code: 'CP-03', status: ContentStatus.DRAFT }),
      item({ code: 'CP-04', status: ContentStatus.SUPERSEDED }),
      item({ code: 'CP-05', status: ContentStatus.RETIRED }),
    ]);

    const result = await service.resolve({
      kind: ContentKind.CHECKIN_PROMPT,
      codes: ['CP-01', 'CP-02', 'CP-03', 'CP-04', 'CP-05'],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.map((r) => r.code)).toEqual(['CP-01']);
  });

  it('honours the effective window against an injected clock', async () => {
    prisma.contentItem.findMany.mockResolvedValue([
      item({ code: 'CP-10', effectiveFrom: new Date('2026-07-01T00:00:00.000Z') }),
      item({ code: 'CP-11', effectiveTo: new Date('2026-05-01T00:00:00.000Z') }),
      item({
        code: 'CP-12',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-12-01T00:00:00.000Z'),
      }),
    ]);

    const result = await service.resolve({
      kind: ContentKind.CHECKIN_PROMPT,
      codes: ['CP-10', 'CP-11', 'CP-12'],
      now: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.map((r) => r.code)).toEqual(['CP-12']);
  });

  it('refuses a BLOCKED code as a 403, not a silent empty', async () => {
    prisma.contentItem.findMany.mockResolvedValue([
      item({ code: 'CP-09', status: ContentStatus.BLOCKED }),
    ]);

    await expect(
      service.resolve({ kind: ContentKind.SAFEGUARDING_PROMPT, codes: ['CP-09'] }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('prefers age-band-specific wording over the all-bands row for a code', async () => {
    prisma.contentItem.findMany.mockResolvedValue([
      item({ code: 'CP-05', ageBand: null, id: 'all' }),
      item({ code: 'CP-05', ageBand: '13-15', id: 'teen' }),
    ]);

    const result = await service.resolve({
      kind: ContentKind.CHECKIN_PROMPT,
      codes: ['CP-05'],
      ageBand: '13-15',
      now: new Date(),
    });

    expect(result[0]?.id).toBe('teen');
  });

  it('falls back to the all-bands row when no band is requested', async () => {
    prisma.contentItem.findMany.mockResolvedValue([
      item({ code: 'CP-05', ageBand: null, id: 'all' }),
      item({ code: 'CP-05', ageBand: '13-15', id: 'teen' }),
    ]);

    const result = await service.resolve({
      kind: ContentKind.CHECKIN_PROMPT,
      codes: ['CP-05'],
      now: new Date(),
    });

    expect(result[0]?.id).toBe('all');
  });

  it('scopes every read to the requested kind and locale', async () => {
    await service.resolve({
      kind: ContentKind.EMOTION_TERM,
      codes: ['EMO-001'],
      locale: 'yo',
    });

    expect(prisma.contentItem.findMany).toHaveBeenCalledWith({
      where: { kind: ContentKind.EMOTION_TERM, code: { in: ['EMO-001'] }, locale: 'yo' },
    });
  });

  it('lists the register for the admin table, newest version first', async () => {
    await service.list({ kind: ContentKind.CHECKIN_PROMPT });

    expect(prisma.contentItem.findMany).toHaveBeenCalledWith({
      where: { kind: ContentKind.CHECKIN_PROMPT, status: undefined, locale: undefined },
      orderBy: [
        { code: 'asc' },
        { majorVersion: 'desc' },
        { minorVersion: 'desc' },
        { patchVersion: 'desc' },
      ],
    });
  });

  describe('assertAskable — what a surface may put to a student', () => {
    it('stays out of the database when there is nothing to check', async () => {
      await service.assertAskable([]);
      expect(prisma.contentItem.findMany).not.toHaveBeenCalled();
    });

    it('accepts a registered prompt once, whatever the duplicate codes in the request', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'CP-05', status: ContentStatus.CONTENT_REVIEW_REQUIRED }),
      ]);

      await expect(
        service.assertAskable(['CP-05', 'CP-05']),
      ).resolves.toBeUndefined();

      expect(prisma.contentItem.findMany).toHaveBeenCalledWith({
        where: { code: { in: ['CP-05'] } },
        select: { code: true, status: true },
      });
    });

    it('refuses a BLOCKED safety prompt with a 403, not a silent pass', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'CP-09', status: ContentStatus.BLOCKED }),
      ]);

      await expect(service.assertAskable(['CP-09'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses an unregistered code, because nothing was ever written down for it', async () => {
      prisma.contentItem.findMany.mockResolvedValue([]);

      await expect(service.assertAskable(['CP-99'])).rejects.toThrow(
        'Content CP-99 is not askable',
      );
    });

    it('refuses a draft or retired code as firmly as a blocked one', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'CP-03', status: ContentStatus.DRAFT }),
        item({ code: 'CP-04', status: ContentStatus.RETIRED }),
      ]);

      await expect(
        service.assertAskable(['CP-03', 'CP-04']),
      ).rejects.toThrow('CP-03, CP-04');
    });
  });

  describe('liveCodes — what a catalogue may show right now', () => {
    it('asks the register for one kind, in one read', async () => {
      await service.liveCodes({ kind: ContentKind.WELLBEING_RESOURCE });

      expect(prisma.contentItem.findMany).toHaveBeenCalledWith({
        where: { kind: ContentKind.WELLBEING_RESOURCE, locale: 'en' },
        select: {
          code: true,
          status: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });
    });

    it('keeps only approved rows inside the effective window', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'WN-01' }),
        item({ code: 'WN-02', status: ContentStatus.CONTENT_REVIEW_REQUIRED }),
        item({ code: 'WN-03', status: ContentStatus.DRAFT }),
        item({ code: 'WN-04', status: ContentStatus.SUPERSEDED }),
        item({ code: 'WN-05', status: ContentStatus.RETIRED }),
        item({ code: 'WN-06', effectiveFrom: new Date('2026-12-01T00:00:00.000Z') }),
        item({ code: 'WN-07', effectiveTo: new Date('2026-01-01T00:00:00.000Z') }),
      ]);

      const live = await service.liveCodes({
        kind: ContentKind.WELLBEING_RESOURCE,
        now: new Date('2026-06-01T00:00:00.000Z'),
      });

      expect([...live]).toEqual(['WN-01']);
    });

    it('lets a BLOCKED row veto a code that also has an approved version', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'WN-08' }),
        item({ code: 'WN-08', status: ContentStatus.BLOCKED, id: 'row-2' }),
      ]);

      const live = await service.liveCodes({
        kind: ContentKind.WELLBEING_RESOURCE,
      });

      expect(live.has('WN-08')).toBe(false);
    });

    it('does not let age band gate a code — bands change wording, not meaning', async () => {
      prisma.contentItem.findMany.mockResolvedValue([
        item({ code: 'WN-09', ageBand: '13-15' }),
      ]);

      const live = await service.liveCodes({
        kind: ContentKind.WELLBEING_RESOURCE,
      });

      expect([...live]).toEqual(['WN-09']);
    });
  });
});
