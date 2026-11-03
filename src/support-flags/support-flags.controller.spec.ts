import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuthService } from '../auth/auth.service.js';
import { AppValidationPipe } from '../common/pipes/validation.pipe.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { SupportFlagsController } from './support-flags.controller.js';
import { SupportFlagsService } from './support-flags.service.js';

const root = '/api/v1/support-flags';
const id = 'b1f7c2a4-6d3e-4f8a-9c21-0e5b7d8a3f46';

/**
 * Mirrors the production Better-Auth global guard. Every route on this
 * controller is class-level `@Roles(...)`, so `RolesGuard` would attach the
 * session itself — but the guard order in this stack is not something to
 * assume (see the RolesGuard story in docs/HANDOFF.md), and the session has to
 * exist for `@Session()` to read it. Registered ahead of `RolesGuard` exactly
 * as it is in `app.module.ts`.
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

describe('SupportFlagsController (Doc A reviewer surface)', () => {
  let app: NestFastifyApplication;
  const service = {
    list: vi.fn(),
    detail: vi.fn(),
    recordReviewDecision: vi.fn(),
    acknowledge: vi.fn(),
    markInReview: vi.fn(),
  };
  const auth = { getSession: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SupportFlagsController],
      providers: [
        { provide: SupportFlagsService, useValue: service },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: AttachSessionGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: AppValidationPipe },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    auth.getSession.mockResolvedValue({ user: { id: 'staff-1', role: 'PSYCHOLOGIST' } });
    service.list.mockResolvedValue({ items: [], openCount: 0, levelCounts: {} });
    service.detail.mockResolvedValue({ id });
    service.recordReviewDecision.mockResolvedValue({ message: 'Decision recorded' });
    service.acknowledge.mockResolvedValue({ message: 'Flag acknowledged' });
    service.markInReview.mockResolvedValue({ message: 'Flag marked in-review' });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('the list read', () => {
    it('passes all four filters through, including the Doc A level', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `${root}?severity=TIER_2_HIGH&status=OPEN&level=B&q=GSS-0142`,
      });

      expect(response.statusCode).toBe(200);
      expect(service.list).toHaveBeenCalledExactlyOnceWith('staff-1', {
        severity: 'TIER_2_HIGH',
        status: 'OPEN',
        level: 'B',
        q: 'GSS-0142',
      });
    });

    it('sends undefined rather than an empty string when no filter is given', async () => {
      await app.inject({ method: 'GET', url: root });

      expect(service.list).toHaveBeenCalledExactlyOnceWith('staff-1', {
        severity: undefined,
        status: undefined,
        level: undefined,
        q: undefined,
      });
    });

    it('does not treat the level as a severity, whatever the caller calls it', async () => {
      // The two axes are separate (Doc A G1), so a level value must arrive as
      // `level` and never be folded into `severity` by a lenient route.
      await app.inject({ method: 'GET', url: `${root}?level=U` });

      expect(service.list.mock.calls[0][1]).toEqual({
        severity: undefined,
        status: undefined,
        level: 'U',
        q: undefined,
      });
    });
  });

  describe('the detail read', () => {
    it('routes a real id to the detail handler, not to the list', async () => {
      const response = await app.inject({ method: 'GET', url: `${root}/${id}` });

      expect(response.statusCode).toBe(200);
      expect(service.detail).toHaveBeenCalledExactlyOnceWith('staff-1', id);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('refuses a malformed id before the service sees it', async () => {
      const response = await app.inject({ method: 'GET', url: `${root}/not-a-uuid` });

      expect(response.statusCode).toBe(400);
      expect(service.detail).not.toHaveBeenCalled();
    });
  });

  describe('the review decision', () => {
    it.each([
      'NO_FURTHER_ACTION',
      'FOLLOW_UP_WITH_STUDENT',
      'FOLLOW_SAFEGUARDING_PROCEDURE',
    ])('accepts %s and records it as a decision', async (decision) => {
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/review-decision`,
        payload: { decision },
      });

      expect(response.statusCode).toBe(201);
      expect(service.recordReviewDecision).toHaveBeenCalledExactlyOnceWith(
        'staff-1',
        id,
        decision,
      );
      // Recording a decision is not a status transition (US-D10): the two
      // workflow writers stay untouched by this route.
      expect(service.acknowledge).not.toHaveBeenCalled();
      expect(service.markInReview).not.toHaveBeenCalled();
    });

    it('refuses RESOLVED, because a decision is not a way to close a flag', async () => {
      // The fourth option Doc A forbids. It is not in the enum, so the DTO
      // rejects it — and the reviewer's screen has no control that would send
      // it either. If someone widens SupportFlagReviewDecision to make a
      // "close" button possible, this test is the conversation they must have
      // first.
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/review-decision`,
        payload: { decision: 'RESOLVED' },
      });

      expect(response.statusCode).toBe(400);
      expect(service.recordReviewDecision).not.toHaveBeenCalled();
    });

    it('refuses a missing decision', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/review-decision`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(service.recordReviewDecision).not.toHaveBeenCalled();
    });

    it('refuses an extra field rather than ignoring it', async () => {
      // `forbidNonWhitelisted` matters here: a client that quietly sends
      // `status` alongside its decision must not have that field stripped and
      // the request accepted, because that is how a close sneaks in.
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/review-decision`,
        payload: { decision: 'NO_FURTHER_ACTION', status: 'RESOLVED' },
      });

      expect(response.statusCode).toBe(400);
      expect(service.recordReviewDecision).not.toHaveBeenCalled();
    });
  });

  describe('the two workflow writers', () => {
    it('routes acknowledge to its own handler', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/acknowledge`,
      });

      expect(response.statusCode).toBe(201);
      expect(service.acknowledge).toHaveBeenCalledExactlyOnceWith('staff-1', id);
      expect(service.recordReviewDecision).not.toHaveBeenCalled();
    });

    it('routes in-review to its own handler', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/in-review`,
      });

      expect(response.statusCode).toBe(201);
      expect(service.markInReview).toHaveBeenCalledExactlyOnceWith('staff-1', id);
    });

    it('offers no route that resolves a flag', async () => {
      // US-D09 as a routing fact: there is no POST :id/resolve to reach, so the
      // only way RESOLVED gets written is a code change, not a click.
      const response = await app.inject({
        method: 'POST',
        url: `${root}/${id}/resolve`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('the role matrix as it stands today', () => {
    // Recorded as evidence for open decision D2, not as an endorsement: the API
    // admits SUPPORT_STAFF to every reviewer route while the frontend rail does
    // not show them the screen. Both sides were left as they were found.
    it.each(['STUDENT', 'SCHOOL_ADMIN', 'PLATFORM_ADMIN'])(
      'refuses the whole surface to %s',
      async (role) => {
        auth.getSession.mockResolvedValue({ user: { id: 'x-1', role } });

        for (const request of [
          { method: 'GET' as const, url: root },
          { method: 'GET' as const, url: `${root}/${id}` },
          {
            method: 'POST' as const,
            url: `${root}/${id}/review-decision`,
            payload: { decision: 'NO_FURTHER_ACTION' },
          },
          { method: 'POST' as const, url: `${root}/${id}/acknowledge` },
        ]) {
          const response = await app.inject(request);
          expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        }
        expect(service.list).not.toHaveBeenCalled();
        expect(service.recordReviewDecision).not.toHaveBeenCalled();
      },
    );

    it.each(['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'])(
      'admits %s to the queue read',
      async (role) => {
        auth.getSession.mockResolvedValue({ user: { id: 'x-1', role } });

        expect((await app.inject({ method: 'GET', url: root })).statusCode).toBe(200);
      },
    );

    it('refuses anonymous access before anything is read', async () => {
      auth.getSession.mockRejectedValue(new UnauthorizedException());

      expect((await app.inject({ method: 'GET', url: root })).statusCode).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
    });
  });
});
