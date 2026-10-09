import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthService } from '../../auth/auth.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface SessionAwareRequest {
  session?: { user?: { id?: string } | null } | null;
  headers?: unknown;
  raw?: { method?: string; url?: string };
  url?: string;
  method?: string;
  [key: string]: unknown;
}

/// Routes a user mid-forced-password-change may still reach: their own
/// profile and the first-password endpoint itself.
const PASSWORD_CHANGE_ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/v1/users/me' },
  { method: 'POST', path: '/api/v1/auth/first-password' },
];

/**
 * Tenant-status enforcement for every Nest route under /api/v1:
 *  - deactivated accounts are cut off (ACCOUNT_DEACTIVATED)
 *  - suspended-school users are cut off (SCHOOL_SUSPENDED)
 *  - users flagged mustChangePassword can only reach the allowlist above
 *    until they set their own password (PASSWORD_CHANGE_REQUIRED)
 *
 * Runs after the auth + role guards. These 403s pair with the sign-in-time
 * checks in auth.config.ts, so sessions issued before a suspension die on
 * the next request instead of living until expiry.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SessionAwareRequest>();
    const path = (req.raw?.url ?? req.url ?? '').split('?')[0];
    // Everything outside the v1 API surface (auth middleware, verification,
    // health) is not tenant-scoped.
    if (!path.startsWith('/api/v1')) return true;

    const method = (req.raw?.method ?? req.method ?? '').toUpperCase();
    if (
      PASSWORD_CHANGE_ALLOWLIST.some(
        (route) => route.method === method && route.path === path,
      )
    ) {
      return true;
    }

    const userId = await this.resolveUserId(req);
    if (!userId) return true; // the auth guard owns the 401 path

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deactivatedAt: true,
        mustChangePassword: true,
        school: { select: { status: true } },
      },
    });
    if (!user) return true;

    if (user.deactivatedAt) {
      throw new ForbiddenException({
        message: 'This account has been deactivated. Contact your school administrator.',
        error: 'Forbidden',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }
    if (user.school?.status === 'SUSPENDED') {
      throw new ForbiddenException({
        message: 'Your school is currently suspended. Contact your school administrator.',
        error: 'Forbidden',
        code: 'SCHOOL_SUSPENDED',
      });
    }
    if (user.mustChangePassword) {
      throw new ForbiddenException({
        message: 'Set your own password to finish onboarding before continuing.',
        error: 'Forbidden',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    return true;
  }

  /// Same lazy resolution as RolesGuard — the library guard normally fills
  /// request.session first, but registration order is not guaranteed.
  private async resolveUserId(req: SessionAwareRequest): Promise<string | null> {
    if (req.session?.user?.id) return req.session.user.id;
    if (typeof req.headers !== 'object' || req.headers === null) return null;
    try {
      const resolved = await this.authService.getSession(
        new Headers(req.headers as Record<string, string>),
      );
      req.session = resolved;
      return resolved?.user?.id ?? null;
    } catch {
      return null; // the auth guard owns the 401 path
    }
  }
}
