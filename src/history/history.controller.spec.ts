import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { HistoryDeletionScope } from '@prisma/client';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { HistoryController } from './history.controller.js';
import { HistoryDeletionService } from './history-deletion.service.js';
import { HistoryService } from './history.service.js';

const checkInId = '22d5780e-49e4-43fc-8737-743094ea9292';
const root = '/api/v1/history';
const roles = [
  'STUDENT',
  'COUNSELLOR',
  'PSYCHOLOGIST',
  'SUPPORT_STAFF',
  'SCHOOL_ADMIN',
  'PLATFORM_ADMIN',
];

describe('HistoryController', () => {
  let app: NestFastifyApplication;
  const service = { list: vi.fn(), detail: vi.fn() };
  const deletion = { create: vi.fn(), listMine: vi.fn() };
  const auth = { getSession: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HistoryController],
      providers: [
        { provide: HistoryService, useValue: service },
        { provide: HistoryDeletionService, useValue: deletion },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    service.list.mockResolvedValue({ items: [], counts: { all: 0, checkIns: 0, reflections: 0, supportRequests: 0 } });
    service.detail.mockResolvedValue({ checkInId, messages: [] });
    deletion.create.mockResolvedValue({ id: 'request-1', scope: 'ALL_HISTORY', alertedAt: new Date() });
    deletion.listMine.mockResolvedValue({ items: [] });
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'STUDENT' } });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('GET /api/v1/history', () => {
    it.each(roles)(
      'is readable only by the student themselves, never by %s',
      async (role) => {
        auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role } });

        const response = await app.inject({ method: 'GET', url: root });

        if (role === 'STUDENT') {
          expect(response.statusCode).toBe(200);
          expect(service.list).toHaveBeenCalledExactlyOnceWith('actor-1');
        } else {
          expect(response.statusCode).toBe(403);
          expect(service.list).not.toHaveBeenCalled();
        }
      },
    );

    it('rejects an unauthenticated request before service access', async () => {
      auth.getSession.mockRejectedValue(new UnauthorizedException());

      const response = await app.inject({ method: 'GET', url: root });

      expect(response.statusCode).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/history/:checkInId', () => {
    it('hands the student their own entry', async () => {
      const response = await app.inject({ method: 'GET', url: `${root}/${checkInId}` });

      expect(response.statusCode).toBe(200);
      expect(service.detail).toHaveBeenCalledExactlyOnceWith('actor-1', checkInId);
    });

    it('answers 404 — not 403 — when the id is not theirs, so it confirms nothing', async () => {
      service.detail.mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: `${root}/${checkInId}` });

      expect(response.statusCode).toBe(404);
    });

    it('validates the id before service access', async () => {
      const response = await app.inject({ method: 'GET', url: `${root}/not-a-uuid` });

      expect(response.statusCode).toBe(400);
      expect(service.detail).not.toHaveBeenCalled();
    });

    it.each(['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN'])(
      'is closed to %s, whose own dashboards already show what they need',
      async (role) => {
        auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role } });

        const response = await app.inject({ method: 'GET', url: `${root}/${checkInId}` });

        expect(response.statusCode).toBe(403);
        expect(service.detail).not.toHaveBeenCalled();
      },
    );
  });

  describe('deletion requests', () => {
    const asks = [
      {
        method: 'GET' as const,
        url: `${root}/deletion-requests`,
        spy: () => deletion.listMine,
        status: 200,
      },
      {
        method: 'POST' as const,
        url: `${root}/deletion-requests`,
        payload: { scope: HistoryDeletionScope.ALL_HISTORY },
        spy: () => deletion.create,
        status: 201,
      },
    ];

    it.each(asks)(
      'is the student’s own action only, and never shadowed by :checkInId ($method $url)',
      async (ask) => {
        const response = await app.inject({
          method: ask.method,
          url: ask.url,
          ...('payload' in ask ? { payload: ask.payload } : {}),
        });

        expect(response.statusCode).toBe(ask.status);
        expect(ask.spy()).toHaveBeenCalledTimes(1);
        expect(service.detail).not.toHaveBeenCalled();
      },
    );

    it.each(roles.filter((role) => role !== 'STUDENT'))(
      'is closed to %s — a professional cannot file the ask for a student',
      async (role) => {
        auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role } });

        const list = await app.inject({ method: 'GET', url: `${root}/deletion-requests` });
        const post = await app.inject({
          method: 'POST',
          url: `${root}/deletion-requests`,
          payload: { scope: HistoryDeletionScope.ALL_HISTORY },
        });

        expect(list.statusCode).toBe(403);
        expect(post.statusCode).toBe(403);
        expect(deletion.listMine).not.toHaveBeenCalled();
        expect(deletion.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      {},
      { scope: 'everything' },
      { scope: HistoryDeletionScope.ALL_HISTORY, beforeDate: 'not-a-date' },
      { scope: HistoryDeletionScope.SELECTED_CHECK_INS, checkInIds: '22d5780e-49e4-43fc-8737-743094ea9292' },
      { scope: HistoryDeletionScope.ALL_HISTORY, deleted: true },
    ])('rejects a malformed ask before the service sees it %#', async (payload) => {
      const response = await app.inject({ method: 'POST', url: `${root}/deletion-requests`, payload });

      expect(response.statusCode).toBe(400);
      expect(deletion.create).not.toHaveBeenCalled();
    });
  });
});
