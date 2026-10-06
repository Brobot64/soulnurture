import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, type AppRole } from './roles.decorator.js';
import { AuthService } from '../../auth/auth.service.js';

interface SessionAwareRequest {
  session?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

/**
 * Enforces role-based access on routes marked with @Roles(...).
 *
 * Better Auth's global guard lazily attaches the session to the request, and
 * registration order does not guarantee it runs before this guard — so this
 * guard resolves the session itself when the request still lacks one, then
 * reads the resolved user's role from the session. Guard semantics remain:
 * 401 when no session can be resolved on a role-protected route, 403 when
 * the role is unresolvable/unauthorised.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<SessionAwareRequest>();
    let session = req.session as
      | { user?: { role?: string | null } | null }
      | null
      | undefined;

    if (!session?.user) {
      if (typeof req.headers !== 'object' || req.headers === null) {
        throw new UnauthorizedException('Authentication required');
      }
      const resolved = await this.authService.getSession(
        new Headers(req.headers as Record<string, string>),
      );
      session = resolved as { user?: { role?: string | null } | null } | null;
      req.session = resolved;
      req.user = resolved?.user ?? null;
    }

    const role = session?.user?.role as AppRole | undefined;
    if (!role) {
      throw new ForbiddenException('Role not resolvable from session');
    }
    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException('Insufficient permissions for this resource');
    }
    return true;
  }
}
