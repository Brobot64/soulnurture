import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiResponseReportsService } from './ai-response-reports.service.js';

const base = {
  id: 'report-1', messageId: 'message-1', responseContent: 'Original reply', responseLanguage: 'yo',
  note: 'Original note\nẸ ṣé.', createdAt: new Date(), message: { conversationId: 'conv-1' },
};
const report = { ...base, reviewOutcome: null, reviewedAt: null, reviewedBy: null };
const submitted = { id: base.id, messageId: base.messageId, responseContent: base.responseContent,
  responseLanguage: base.responseLanguage, note: base.note, createdAt: base.createdAt, conversationId: 'conv-1' };
const view = { ...submitted, reviewOutcome: null, reviewedAt: null, reviewedBy: null };
const dto = { messageId: 'message-1', expectedContent: 'Original reply', note: base.note };
const owner = { student: { userId: 'student-user', user: { role: 'STUDENT', schoolId: 'school-1' } } };
const school = { student: { user: { schoolId: 'school-1' } } };
const baseSelect = { id: true, messageId: true, responseContent: true, responseLanguage: true, note: true,
  createdAt: true, message: { select: { conversationId: true } } };
const selected = { ...baseSelect, reviewOutcome: true, reviewedAt: true,
  reviewedBy: { select: { name: true, role: true } } };
const guardSelect = { id: true, reviewOutcome: true, reviewedById: true };

function mocks() {
  const tx = {
    conversationMessage: { findFirst: vi.fn().mockResolvedValue({ id: 'message-1', content: 'Original reply', language: 'yo' }) },
    aiResponseReport: {
      findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(base),
      update: vi.fn().mockResolvedValue(report),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ role: 'STUDENT', schoolId: 'school-1' }) },
    conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conv-1' }) },
    aiResponseReport: { findFirst: vi.fn().mockResolvedValue(report), findMany: vi.fn().mockResolvedValue([report]) },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { prisma, tx };
}

describe('AiResponseReportsService', () => {
  let setup: ReturnType<typeof mocks>;
  let service: AiResponseReportsService;
  beforeEach(() => {
    setup = mocks();
    service = new AiResponseReportsService(setup.prisma as unknown as PrismaService);
  });

  it('snapshots only an owned assistant response and writes an atomic metadata-only audit', async () => {
    const { tx, prisma } = setup;
    expect(await service.submit('student-user', dto)).toEqual({ report: submitted, alreadyReported: false });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.conversationMessage.findFirst).toHaveBeenCalledWith({
      where: { id: 'message-1', role: 'ASSISTANT', conversation: owner }, select: { id: true, content: true, language: true },
    });
    expect(tx.aiResponseReport.create).toHaveBeenCalledWith({ data: {
      messageId: 'message-1', responseContent: 'Original reply', responseLanguage: 'yo', note: base.note,
    }, select: baseSelect });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: {
      actorId: 'student-user', schoolId: 'school-1', action: 'ai_response_report.created', entity: 'AiResponseReport', entityId: 'report-1',
    } });
  });

  it.each([undefined, '', '  \n'])('stores no note for optional empty input %j', async (note) => {
    await service.submit('student-user', { ...dto, note });
    expect(setup.tx.aiResponseReport.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ note: null }) }));
  });

  it('returns an existing report unchanged even when the message was subsequently replaced', async () => {
    setup.tx.aiResponseReport.findUnique.mockResolvedValue(base);
    expect(await service.submit('student-user', { ...dto, expectedContent: 'Later reply', note: 'New note' }))
      .toEqual({ report: submitted, alreadyReported: true });
    expect(setup.tx.aiResponseReport.create).not.toHaveBeenCalled();
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects stale displayed content rather than reporting a different reply', async () => {
    await expect(service.submit('student-user', { ...dto, expectedContent: 'Old displayed reply' })).rejects.toThrow(ConflictException);
    expect(setup.tx.aiResponseReport.create).not.toHaveBeenCalled();
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not report a foreign, missing or non-assistant message', async () => {
    setup.tx.conversationMessage.findFirst.mockResolvedValue(null);
    await expect(service.submit('student-user', dto)).rejects.toThrow(NotFoundException);
    expect(setup.tx.aiResponseReport.findUnique).not.toHaveBeenCalled();
    expect(setup.tx.aiResponseReport.create).not.toHaveBeenCalled();
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects school-less submission before opening a transaction', async () => {
    setup.prisma.user.findUnique.mockResolvedValue({ role: 'STUDENT', schoolId: null });
    await expect(service.submit('student-user', dto)).rejects.toThrow(ForbiddenException);
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the winning report after a concurrent unique conflict without another audit', async () => {
    setup.prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '7.10.0' }));
    setup.prisma.aiResponseReport.findFirst.mockResolvedValueOnce(base);
    expect(await service.submit('student-user', dto)).toEqual({ report: submitted, alreadyReported: true });
    expect(setup.prisma.aiResponseReport.findFirst).toHaveBeenCalledWith({ where: { messageId: dto.messageId, message: { conversation: owner } }, select: baseSelect });
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not swallow other database failures', async () => {
    const error = new Error('write failed');
    setup.tx.auditLog.create.mockRejectedValue(error);
    await expect(service.submit('student-user', dto)).rejects.toBe(error);
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN', null])('denies %s on both student operations', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue(role ? { role, schoolId: 'school-1' } : null);
    await expect(service.submit('student-user', dto)).rejects.toThrow(ForbiddenException);
    await expect(service.mine('student-user', 'conv-1')).rejects.toThrow(ForbiddenException);
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
    expect(setup.prisma.conversation.findFirst).not.toHaveBeenCalled();
  });

  it('reads only receipts from an owned conversation', async () => {
    await service.mine('student-user', 'conv-1');
    expect(setup.prisma.conversation.findFirst).toHaveBeenCalledWith({ where: { id: 'conv-1', student: { userId: 'student-user', user: { role: 'STUDENT' } } }, select: { id: true } });
    expect(setup.prisma.aiResponseReport.findMany).toHaveBeenCalledWith({ where: { message: { conversationId: 'conv-1' } }, select: { id: true, messageId: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  });

  it('hides receipts for foreign or missing conversations', async () => {
    setup.prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.mine('student-user', 'conv-1')).rejects.toThrow(NotFoundException);
    expect(setup.prisma.aiResponseReport.findMany).not.toHaveBeenCalled();
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST'])('scopes %s queue and detail with explicit projections', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue({ role, schoolId: 'school-1' });
    setup.prisma.aiResponseReport.findMany.mockResolvedValue([report, { ...report, id: 'report-2' }]);
    expect(await service.list('reviewer', { limit: 1, offset: 2 })).toEqual({ items: [view], nextOffset: 3 });
    expect(setup.prisma.aiResponseReport.findMany).toHaveBeenCalledWith({ where: { message: { conversation: { student: { user: { schoolId: 'school-1' } } } } }, select: selected, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, skip: 2 });
    expect(await service.getOne('reviewer', 'report-1')).toEqual(view);
    expect(setup.prisma.aiResponseReport.findFirst).toHaveBeenCalledWith({ where: { id: 'report-1', message: { conversation: { student: { user: { schoolId: 'school-1' } } } } }, select: selected });
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns a terminal empty page without a next offset', async () => {
    setup.prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    setup.prisma.aiResponseReport.findMany.mockResolvedValue([]);
    expect(await service.list('reviewer', { limit: 20, offset: 0 })).toEqual({ items: [], nextOffset: null });
  });

  it.each(['STUDENT', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN', null])('denies %s from reviewer reads', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue(role ? { role, schoolId: 'school-1' } : null);
    await expect(service.list('actor', { limit: 20, offset: 0 })).rejects.toThrow(ForbiddenException);
    await expect(service.getOne('actor', 'report-1')).rejects.toThrow(ForbiddenException);
    expect(setup.prisma.aiResponseReport.findMany).not.toHaveBeenCalled();
    expect(setup.prisma.aiResponseReport.findFirst).not.toHaveBeenCalled();
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST'])('denies school-less %s without querying reports', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue({ role, schoolId: null });
    await expect(service.list('actor', { limit: 20, offset: 0 })).rejects.toThrow(NotFoundException);
    await expect(service.getOne('actor', 'report-1')).rejects.toThrow(NotFoundException);
    expect(setup.prisma.aiResponseReport.findMany).not.toHaveBeenCalled();
    expect(setup.prisma.aiResponseReport.findFirst).not.toHaveBeenCalled();
  });

  it('hides a report outside the reviewer school', async () => {
    setup.prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    setup.prisma.aiResponseReport.findFirst.mockResolvedValue(null);
    await expect(service.getOne('reviewer', 'foreign-report')).rejects.toThrow(NotFoundException);
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST'])('records a %s review decision with a metadata-only audit', async (role) => {
    const { prisma, tx } = setup;
    prisma.user.findUnique.mockResolvedValue({ role, schoolId: 'school-1' });
    prisma.aiResponseReport.findFirst
      .mockResolvedValueOnce({ id: 'report-1', reviewOutcome: null, reviewedById: null })
      .mockResolvedValueOnce({ ...report, reviewOutcome: 'FOLLOWED_UP_WITH_STUDENT', reviewedAt: new Date('2026-10-24'), reviewedBy: { name: 'A. Bello', role } });
    expect(await service.review('reviewer', 'report-1', 'FOLLOWED_UP_WITH_STUDENT')).toEqual({
      ...view, reviewOutcome: 'FOLLOWED_UP_WITH_STUDENT', reviewedAt: new Date('2026-10-24'), reviewedBy: { name: 'A. Bello', role },
    });
    expect(prisma.aiResponseReport.findFirst).toHaveBeenNthCalledWith(1, { where: { id: 'report-1', message: { conversation: school } }, select: guardSelect });
    expect(tx.aiResponseReport.update).toHaveBeenCalledWith({ where: { id: 'report-1' }, data: {
      reviewOutcome: 'FOLLOWED_UP_WITH_STUDENT', reviewedById: 'reviewer', reviewedAt: expect.any(Date),
    } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: {
      actorId: 'reviewer', schoolId: 'school-1', action: 'ai_response_report.review_recorded',
      entity: 'AiResponseReport', entityId: 'report-1', meta: { outcome: 'FOLLOWED_UP_WITH_STUDENT' },
    } });
    expect(prisma.aiResponseReport.findFirst).toHaveBeenNthCalledWith(2, { where: { id: 'report-1', message: { conversation: school } }, select: selected });
    expect(tx.conversationMessage.findFirst).not.toHaveBeenCalled();
  });

  it('rewrites a changed decision by the same reviewer so the last call wins', async () => {
    const { prisma, tx } = setup;
    prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    prisma.aiResponseReport.findFirst
      .mockResolvedValueOnce({ id: 'report-1', reviewOutcome: 'CANNOT_ASSESS', reviewedById: 'reviewer' })
      .mockResolvedValueOnce({ ...report, reviewOutcome: 'NO_CHANGE_NEEDED' });
    await service.review('reviewer', 'report-1', 'NO_CHANGE_NEEDED');
    expect(tx.aiResponseReport.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewOutcome: 'NO_CHANGE_NEEDED' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('attributes a repeated decision to the reviewer who made it', async () => {
    const { prisma, tx } = setup;
    prisma.user.findUnique.mockResolvedValue({ role: 'PSYCHOLOGIST', schoolId: 'school-1' });
    prisma.aiResponseReport.findFirst
      .mockResolvedValueOnce({ id: 'report-1', reviewOutcome: 'NO_CHANGE_NEEDED', reviewedById: 'other-reviewer' })
      .mockResolvedValueOnce({ ...report, reviewOutcome: 'NO_CHANGE_NEEDED' });
    await service.review('reviewer', 'report-1', 'NO_CHANGE_NEEDED');
    expect(tx.aiResponseReport.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reviewedById: 'reviewer' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite or re-audit the same decision by the same reviewer', async () => {
    const { prisma, tx } = setup;
    prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    prisma.aiResponseReport.findFirst
      .mockResolvedValueOnce({ id: 'report-1', reviewOutcome: 'NO_CHANGE_NEEDED', reviewedById: 'reviewer' })
      .mockResolvedValueOnce({ ...report, reviewOutcome: 'NO_CHANGE_NEEDED' });
    expect(await service.review('reviewer', 'report-1', 'NO_CHANGE_NEEDED')).toEqual({ ...view, reviewOutcome: 'NO_CHANGE_NEEDED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.aiResponseReport.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['STUDENT', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN', null])('denies %s from recording a review', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue(role ? { role, schoolId: 'school-1' } : null);
    await expect(service.review('actor', 'report-1', 'NO_CHANGE_NEEDED')).rejects.toThrow(ForbiddenException);
    expect(setup.prisma.aiResponseReport.findFirst).not.toHaveBeenCalled();
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
    expect(setup.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST'])('denies a school-less %s review before querying reports', async (role) => {
    setup.prisma.user.findUnique.mockResolvedValue({ role, schoolId: null });
    await expect(service.review('actor', 'report-1', 'CANNOT_ASSESS')).rejects.toThrow(NotFoundException);
    expect(setup.prisma.aiResponseReport.findFirst).not.toHaveBeenCalled();
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes nothing for a report outside the reviewer school', async () => {
    const { prisma, tx } = setup;
    prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    prisma.aiResponseReport.findFirst.mockResolvedValue(null);
    await expect(service.review('reviewer', 'foreign-report', 'NO_CHANGE_NEEDED')).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.aiResponseReport.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not swallow a failed review write', async () => {
    const error = new Error('write failed');
    setup.prisma.user.findUnique.mockResolvedValue({ role: 'COUNSELLOR', schoolId: 'school-1' });
    setup.prisma.aiResponseReport.findFirst.mockResolvedValueOnce({ id: 'report-1', reviewOutcome: null, reviewedById: null });
    setup.tx.auditLog.create.mockRejectedValue(error);
    await expect(service.review('reviewer', 'report-1', 'NO_CHANGE_NEEDED')).rejects.toBe(error);
  });

  it('keeps the review fields out of the student receipts', async () => {
    setup.prisma.aiResponseReport.findMany.mockResolvedValue([]);
    expect(await service.mine('student-user', 'conv-1')).toEqual({ items: [] });
    expect(setup.prisma.aiResponseReport.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, messageId: true, createdAt: true },
    }));
  });
});
