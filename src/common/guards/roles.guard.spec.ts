import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../../auth/auth.service.js';
import { RolesGuard } from './roles.guard.js';
import { ROLES_KEY } from './roles.decorator.js';

function makeContext(userRole?: string) {
  const req = {
    session: userRole ? { user: { role: userRole } } : null,
    headers: { cookie: 'better-auth.session_token=x' },
  };
  return req;
}

function makeExecutionContext(req: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => class {},
  } as unknown as Parameters<RolesGuard['canActivate']>[0];
}

describe('RolesGuard', () => {
  function build(returnRoles: unknown) {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(returnRoles),
    } as unknown as Reflector;
    const authService = {
      getSession: vi
        .fn()
        .mockResolvedValue({ user: { role: 'PSYCHOLOGIST' } }),
    };
    return {
      authService,
      guard: new RolesGuard(reflector, authService as unknown as AuthService),
      reflector,
    };
  }

  it('allows through when no roles required', async () => {
    const { authService, guard } = build(undefined);
    await expect(
      guard.canActivate(makeExecutionContext(makeContext('STUDENT'))),
    ).resolves.toBe(true);
    expect(authService.getSession).not.toHaveBeenCalled();
  });

  it('allows a matching role from an already-attached session', async () => {
    const { authService, guard, reflector } = build([
      'COUNSELLOR',
      'PSYCHOLOGIST',
    ]);
    await expect(
      guard.canActivate(makeExecutionContext(makeContext('PSYCHOLOGIST'))),
    ).resolves.toBe(true);
    expect(authService.getSession).not.toHaveBeenCalled();
    const calls = reflector.getAllAndOverride.mock.calls[0] as unknown[];
    expect(calls[0]).toBe(ROLES_KEY);
    expect(calls[1]).toHaveLength(2);
  });

  it('rejects a non-matching role', async () => {
    const { guard } = build(['COUNSELLOR', 'PSYCHOLOGIST']);
    await expect(
      guard.canActivate(makeExecutionContext(makeContext('STUDENT'))),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resolves the session itself when the auth guard has not attached one yet', async () => {
    const { authService, guard } = build(['PSYCHOLOGIST']);
    const req = makeContext(undefined); // no session on the request yet
    await expect(
      guard.canActivate(makeExecutionContext(req)),
    ).resolves.toBe(true);
    expect(authService.getSession).toHaveBeenCalledTimes(1);
    expect((req as { session: { user: { role: string } } }).session.user.role).toBe(
      'PSYCHOLOGIST',
    );
  });

  it('401s when no session can be resolved at all for a guarded route', async () => {
    const { authService, guard } = build(['PSYCHOLOGIST']);
    authService.getSession.mockRejectedValue(new UnauthorizedException('x'));
    await expect(
      guard.canActivate(makeExecutionContext(makeContext(undefined))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('403s when the session resolves but carries no role', async () => {
    const { authService, guard } = build(['PSYCHOLOGIST']);
    authService.getSession.mockResolvedValue({ user: { role: null } });
    await expect(
      guard.canActivate(makeExecutionContext(makeContext(undefined))),
    ).rejects.toThrow(ForbiddenException);
  });
});
