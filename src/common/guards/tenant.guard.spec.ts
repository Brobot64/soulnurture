import { ForbiddenException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

interface StubRequest {
  session?: { user?: { id?: string } | null } | null;
  headers?: unknown;
  raw?: { method?: string; url?: string };
  url?: string;
  method?: string;
}

function makeContext(req: StubRequest) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as Parameters<TenantGuard['canActivate']>[0];
}

function fastifyRequest(method: string, url: string): StubRequest {
  return { raw: { method, url }, headers: { cookie: 'better-auth.session_token=x' } };
}

async function rejectionOf(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => error as ForbiddenException,
  );
}

describe('TenantGuard', () => {
  const prisma = { user: { findUnique: vi.fn() } };
  const authService = { getSession: vi.fn() };
  let guard: TenantGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    guard = new TenantGuard(
      prisma as unknown as PrismaService,
      authService as unknown as AuthService,
    );
    prisma.user.findUnique.mockResolvedValue({
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
  });

  it('ignores non-v1 routes without touching the DB', async () => {
    await expect(
      guard.canActivate(makeContext(fastifyRequest('GET', '/api/health'))),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        makeContext(fastifyRequest('POST', '/api/auth/sign-in/email')),
      ),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('always lets the password-change allowlist through, even mid-forced-change', async () => {
    const req = {
      ...fastifyRequest('GET', '/api/v1/users/me'),
      session: { user: { id: 'u1' } },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    await expect(
      guard.canActivate(
        makeContext({
          ...fastifyRequest('POST', '/api/v1/auth/first-password?x=1'),
          session: { user: { id: 'u1' } },
        }),
      ),
    ).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('passes unauthenticated requests through (the auth guard owns the 401)', async () => {
    const req: StubRequest = { headers: {} };
    await expect(
      guard.canActivate(makeContext(fastifyRequest('GET', '/api/v1/check-ins'))),
    ).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    authService.getSession.mockRejectedValue(new Error('no session'));
    await expect(
      guard.canActivate(makeContext({ headers: { cookie: 'x' } })),
    ).resolves.toBe(true);
  });

  it('allows an active, flagged-free user through', async () => {
    const req = {
      ...fastifyRequest('GET', '/api/v1/check-ins'),
      session: { user: { id: 'u1' } },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: {
        deactivatedAt: true,
        mustChangePassword: true,
        school: { select: { status: true } },
      },
    });
  });

  it('resolves the session itself when the auth guard has not attached one yet', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'u9' } });
    const req: StubRequest = {
      raw: { method: 'GET', url: '/api/v1/check-ins' },
      headers: { cookie: 'better-auth.session_token=x' },
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);

    expect(authService.getSession).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u9' } }),
    );
    expect(req.session).toEqual({ user: { id: 'u9' } });
  });

  it('403s a deactivated account with ACCOUNT_DEACTIVATED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      deactivatedAt: new Date(),
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
    const req = {
      ...fastifyRequest('GET', '/api/v1/check-ins'),
      session: { user: { id: 'u1' } },
    };

    const rejection = await rejectionOf(guard.canActivate(makeContext(req)));

    expect(rejection?.getStatus()).toBe(403);
    expect(rejection?.getResponse()).toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
  });

  it('403s a suspended school with SCHOOL_SUSPENDED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'SUSPENDED' },
    });
    const req = {
      ...fastifyRequest('GET', '/api/v1/check-ins'),
      session: { user: { id: 'u1' } },
    };

    const rejection = await rejectionOf(guard.canActivate(makeContext(req)));

    expect(rejection?.getStatus()).toBe(403);
    expect(rejection?.getResponse()).toMatchObject({ code: 'SCHOOL_SUSPENDED' });
  });

  it('403s a forced password change everywhere but the allowlist', async () => {
    prisma.user.findUnique.mockResolvedValue({
      deactivatedAt: null,
      mustChangePassword: true,
      school: { status: 'ACTIVE' },
    });
    const req = {
      ...fastifyRequest('POST', '/api/v1/check-ins'),
      session: { user: { id: 'u1' } },
    };

    const rejection = await rejectionOf(guard.canActivate(makeContext(req)));

    expect(rejection?.getStatus()).toBe(403);
    expect(rejection?.getResponse()).toMatchObject({
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  });

  it('lets a user with no school row through (grandfathered accounts)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      deactivatedAt: null,
      mustChangePassword: false,
      school: null,
    });
    const req = {
      ...fastifyRequest('GET', '/api/v1/check-ins'),
      session: { user: { id: 'u1' } },
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('passes through when the user row no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const req = {
      ...fastifyRequest('GET', '/api/v1/check-ins'),
      session: { user: { id: 'u-gone' } },
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
  });

  it('falls back to req.method/req.url when the fastify raw request is absent', async () => {
    const req = {
      session: { user: { id: 'u1' } },
      method: 'GET',
      url: '/api/v1/users/me',
    };

    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
