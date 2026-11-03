import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthService } from '../auth/auth.service.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { SupportRequestsController } from './support-requests.controller.js';
import { SupportRequestsService } from './support-requests.service.js';

const root = '/api/v1/support-requests';
const id = 'd8f96949-85d4-4ca6-88ba-e8470e21dc18';

/**
 * Mirrors the production Better-Auth global guard: it resolves the session and
 * attaches it to the request so `@Session()` can read it on role-free routes.
 * `RolesGuard` only attaches it for `@Roles(...)` routes, and `GET :id` is
 * deliberately role-free (students read their own request), so without this the
 * app under test has no session to hand the handler.
 */
@Injectable()
class AttachSessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ session?: unknown; headers?: unknown }>();
    if (!req.session) {
      req.session = await this.authService.getSession(
        new Headers((req.headers as Record<string, string>) ?? {}),
      );
    }
    return true;
  }
}

describe('SupportRequestsController staff queue routes', () => {
  let app: NestFastifyApplication;
  const service = {
    listQueue: vi.fn(),
    queueCounts: vi.fn(),
    getOne: vi.fn(),
    markRead: vi.fn(),
  };
  const auth = { getSession: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SupportRequestsController],
      providers: [
        { provide: SupportRequestsService, useValue: service },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: AttachSessionGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    auth.getSession.mockResolvedValue({ user: { id: 'staff-1', role: 'COUNSELLOR' } });
    service.listQueue.mockResolvedValue({ items: [], counts: {} });
    service.queueCounts.mockResolvedValue({ all: 0, new: 0 });
    service.getOne.mockResolvedValue({ id });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sends queue/counts to the counts handler, not to the :id route', async () => {
    const response = await app.inject({ method: 'GET', url: `${root}/queue/counts` });

    expect(response.statusCode).toBe(200);
    expect(service.queueCounts).toHaveBeenCalledExactlyOnceWith('staff-1');
    expect(service.getOne).not.toHaveBeenCalled();
  });

  it('still routes a real id to the detail handler', async () => {
    const response = await app.inject({ method: 'GET', url: `${root}/${id}` });

    expect(response.statusCode).toBe(200);
    expect(service.getOne).toHaveBeenCalledExactlyOnceWith('staff-1', id);
    expect(service.queueCounts).not.toHaveBeenCalled();
  });

  it('routes a POST :id/read to the mark-read handler for staff', async () => {
    service.markRead.mockResolvedValue({ readAt: new Date('2026-10-30T10:00:00Z') });

    const response = await app.inject({ method: 'POST', url: `${root}/${id}/read` });

    expect(response.statusCode).toBe(201);
    expect(service.markRead).toHaveBeenCalledExactlyOnceWith('staff-1', id);
  });

  it('refuses the read route to a student', async () => {
    auth.getSession.mockResolvedValue({ user: { id: 'stu-1', role: 'STUDENT' } });

    const response = await app.inject({ method: 'POST', url: `${root}/${id}/read` });

    expect(response.statusCode).toBe(403);
    expect(service.markRead).not.toHaveBeenCalled();
  });

  it.each(['STUDENT', 'SCHOOL_ADMIN'])('refuses the badge to %s', async (role) => {
    auth.getSession.mockResolvedValue({ user: { id: 'x-1', role } });

    expect((await app.inject({ method: 'GET', url: `${root}/queue/counts` })).statusCode).toBe(403);
    expect(service.queueCounts).not.toHaveBeenCalled();
  });

  it.each(['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'])('allows the badge to %s', async (role) => {
    auth.getSession.mockResolvedValue({ user: { id: 'x-1', role } });

    expect((await app.inject({ method: 'GET', url: `${root}/queue/counts` })).statusCode).toBe(200);
  });

  it('rejects anonymous access', async () => {
    auth.getSession.mockRejectedValue(new UnauthorizedException());

    expect((await app.inject({ method: 'GET', url: `${root}/queue/counts` })).statusCode).toBe(401);
    expect(service.queueCounts).not.toHaveBeenCalled();
  });
});
