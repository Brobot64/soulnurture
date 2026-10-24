import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

const conversationId = '22d5780e-49e4-43fc-8737-743094ea9292';
const root = '/api/v1/conversations';
const routes = [
  { method: 'POST', url: root, action: 'create', body: { source: 'chat' }, args: [{ source: 'chat' }] },
  { method: 'GET', url: root, action: 'listMine', args: [] },
  { method: 'GET', url: `${root}/${conversationId}`, action: 'getOne', args: [conversationId] },
  { method: 'GET', url: `${root}/${conversationId}/review-context`, action: 'getReviewContext', args: [conversationId] },
  { method: 'POST', url: `${root}/${conversationId}/close`, action: 'close', args: [conversationId] },
  { method: 'POST', url: `${root}/${conversationId}/messages`, action: 'sendMessage', body: { content: 'Synthetic message' }, args: [conversationId, { content: 'Synthetic message' }] },
] as const;

const roles = ['STUDENT', 'COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN'];

describe('ConversationsController role boundaries', () => {
  let app: NestFastifyApplication;
  const service = {
    create: vi.fn(),
    listMine: vi.fn(),
    getOne: vi.fn(),
    getReviewContext: vi.fn(),
    close: vi.fn(),
    sendMessage: vi.fn(),
  };
  const auth = { getSession: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConversationsController],
      providers: [
        { provide: ConversationsService, useValue: service },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    for (const action of Object.values(service)) action.mockResolvedValue({ ok: true });
    auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role: 'STUDENT' } });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe.each(routes)('$method $url', (route) => {
    it.each(roles)('enforces the existing access boundary for %s', async (role) => {
      auth.getSession.mockResolvedValue({ user: { id: 'actor-1', role } });
      const allowed = route.action === 'getReviewContext'
        ? ['COUNSELLOR', 'PSYCHOLOGIST'].includes(role)
        : role === 'STUDENT' ||
          (route.action === 'getOne' && ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'].includes(role));

      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...('body' in route ? { payload: route.body } : {}),
      });

      expect(response.statusCode).toBe(allowed ? route.method === 'POST' ? 201 : 200 : 403);
      if (allowed) {
        expect(service[route.action]).toHaveBeenCalledExactlyOnceWith('actor-1', ...route.args);
      } else {
        for (const action of Object.values(service)) expect(action).not.toHaveBeenCalled();
      }
    });

    it('rejects an unauthenticated request before service access', async () => {
      auth.getSession.mockRejectedValue(new UnauthorizedException());

      const response = await app.inject({
        method: route.method,
        url: route.url,
        ...('body' in route ? { payload: route.body } : {}),
      });

      expect(response.statusCode).toBe(401);
      for (const action of Object.values(service)) expect(action).not.toHaveBeenCalled();
    });
  });

  it('validates conversation IDs before service access', async () => {
    const response = await app.inject({ method: 'GET', url: `${root}/not-a-uuid` });

    expect(response.statusCode).toBe(400);
    expect(service.getOne).not.toHaveBeenCalled();
  });

  it('validates linked check-in IDs before service access', async () => {
    const response = await app.inject({ method: 'POST', url: root, payload: { checkInId: 'not-a-uuid' } });

    expect(response.statusCode).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('validates review-context conversation IDs before service access', async () => {
    auth.getSession.mockResolvedValue({ user: { id: 'reviewer-1', role: 'COUNSELLOR' } });

    const response = await app.inject({ method: 'GET', url: `${root}/not-a-uuid/review-context` });

    expect(response.statusCode).toBe(400);
    expect(service.getReviewContext).not.toHaveBeenCalled();
  });
});
