import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { AppValidationPipe } from '../common/pipes/validation.pipe.js';
import { AiResponseReportsController } from './ai-response-reports.controller.js';
import { AiResponseReportsService } from './ai-response-reports.service.js';

const root = '/api/v1/ai-response-reports';
const id = 'd8f96949-85d4-4ca6-88ba-e8470e21dc18';
const body = { messageId: id, expectedContent: 'Displayed reply', note: 'Synthetic note' };
const routes = [
  { method: 'POST' as const, url: root, action: 'submit' as const, args: [body], payload: body, student: true },
  { method: 'GET' as const, url: `${root}/mine?conversationId=${id}`, action: 'mine' as const, args: [id], student: true },
  { method: 'GET' as const, url: root, action: 'list' as const, args: [{ limit: 20, offset: 0 }], student: false },
  { method: 'GET' as const, url: `${root}/${id}`, action: 'getOne' as const, args: [id], student: false },
  { method: 'PATCH' as const, url: `${root}/${id}/review`, action: 'review' as const, args: [id, 'NO_CHANGE_NEEDED'], payload: { outcome: 'NO_CHANGE_NEEDED' }, student: false },
];

describe('AiResponseReportsController', () => {
  let app: NestFastifyApplication;
  const service = { submit: vi.fn(), mine: vi.fn(), list: vi.fn(), getOne: vi.fn(), review: vi.fn() };
  const auth = { getSession: vi.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [AiResponseReportsController], providers: [
      { provide: AiResponseReportsService, useValue: service }, { provide: AuthService, useValue: auth }, { provide: APP_GUARD, useClass: RolesGuard },
    ] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new AppValidationPipe());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'STUDENT' } });
    for (const action of Object.values(service)) action.mockResolvedValue({ ok: true });
  });
  afterAll(async () => { await app?.close(); });

  describe.each(routes)('$method $url', (route) => {
    it.each(['STUDENT', 'COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN'])('enforces %s access', async (role) => {
      auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role } });
      const allowed = route.student ? role === 'STUDENT' : ['COUNSELLOR', 'PSYCHOLOGIST'].includes(role);
      const response = await app.inject({ method: route.method, url: route.url, ...('payload' in route ? { payload: route.payload } : {}) });
      expect(response.statusCode).toBe(allowed ? 200 : 403);
      if (allowed) expect(service[route.action]).toHaveBeenCalledExactlyOnceWith('actor-1', ...route.args);
      else for (const action of Object.values(service)) expect(action).not.toHaveBeenCalled();
    });
    it('rejects anonymous access', async () => {
      auth.getSession.mockRejectedValue(new UnauthorizedException());
      const response = await app.inject({ method: route.method, url: route.url, ...('payload' in route ? { payload: route.payload } : {}) });
      expect(response.statusCode).toBe(401);
      for (const action of Object.values(service)) expect(action).not.toHaveBeenCalled();
    });
  });

  it.each([
    {}, { ...body, messageId: 'bad' }, { ...body, expectedContent: '' }, { ...body, expectedContent: null },
    { ...body, expectedContent: 1 }, { ...body, expectedContent: true }, { ...body, note: ['text'] }, { ...body, note: false },
    { ...body, expectedContent: 'a'.repeat(20001) }, { ...body, note: 3 }, { ...body, note: 'a'.repeat(2001) },
    { ...body, studentId: id }, { ...body, schoolId: id }, { ...body, status: 'RESOLVED' },
  ])('rejects malformed or client-owned submission fields %#', async (payload) => {
    expect((await app.inject({ method: 'POST', url: root, payload })).statusCode).toBe(400);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it.each(['limit=0', 'limit=51', 'limit=1.2', 'limit=no', 'offset=-1', 'offset=100001', 'offset=1.5', 'schoolId=x'])('rejects invalid pagination %s', async (query) => {
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'COUNSELLOR' } });
    expect((await app.inject({ method: 'GET', url: `${root}?${query}` })).statusCode).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('validates the detail UUID', async () => {
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'COUNSELLOR' } });
    expect((await app.inject({ method: 'GET', url: `${root}/invalid` })).statusCode).toBe(400);
    expect(service.getOne).not.toHaveBeenCalled();
  });
  it.each([
    {}, { outcome: 'DISAGREE' }, { outcome: null }, { outcome: 1 }, { outcome: ['NO_CHANGE_NEEDED'] },
    { outcome: '' }, { outcome: 'NO_CHANGE_NEEDED', note: 'free text' }, { outcome: 'NO_CHANGE_NEEDED', schoolId: id },
  ])('rejects a malformed or client-owned review field %#', async (payload) => {
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'PSYCHOLOGIST' } });
    expect((await app.inject({ method: 'PATCH', url: `${root}/${id}/review`, payload })).statusCode).toBe(400);
    expect(service.review).not.toHaveBeenCalled();
  });
  it('rejects an invalid review UUID', async () => {
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'COUNSELLOR' } });
    const response = await app.inject({ method: 'PATCH', url: `${root}/invalid/review`, payload: { outcome: 'CANNOT_ASSESS' } });
    expect(response.statusCode).toBe(400);
    expect(service.review).not.toHaveBeenCalled();
  });
  it('requires a valid conversation for receipts', async () => {
    expect((await app.inject({ method: 'GET', url: `${root}/mine` })).statusCode).toBe(400);
    expect(service.mine).not.toHaveBeenCalled();
  });
});
