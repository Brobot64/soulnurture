import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { HistoryPurgeService } from '../history/history-purge.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

interface Actor {
  id: string;
  role: UserRole;
  schoolId: string | null;
}

interface Target {
  id: string;
  email: string;
  role: UserRole;
  schoolId: string | null;
  emailVerified: boolean;
}

/**
 * The administrative removal of a person from the platform, and the admin's
 * way of re-issuing a verification email.
 *
 * Two remits, one rule: a platform admin reaches any account, a school admin
 * only accounts that carry their own school. The route the caller came in on
 * never decides that — the actor's role and `schoolId` are read back from the
 * database, exactly as every other school-scoped surface does it, so a forged
 * path parameter buys nothing.
 *
 * Erasure is delegated to Epic H's purge engine rather than reimplemented
 * here. The owner's ruling was that a removed person should look like they
 * never existed; that has one implementation, and an admin action has to meet
 * the same bar as a student's own request or the promise is worth less when
 * someone with a badge makes it.
 */
@Injectable()
export class UserErasureService {
  private readonly logger = new Logger(UserErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly realtime: RealtimeService,
    private readonly purge: HistoryPurgeService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Delete an account and everything that is about it.
   *
   * `schoolId` is the school from the path, when the caller came in through
   * the school surface; the platform route passes null and relies on its own
   * `@Roles('PLATFORM_ADMIN')` gate plus this method's remit check.
   */
  async erase(
    actorId: string,
    targetUserId: string,
    schoolId: string | null,
    confirm = false,
  ) {
    if (confirm !== true) {
      throw new UnprocessableEntityException({
        message: 'Deletion requires an explicit confirmation.',
        error: 'Unprocessable Entity',
        code: 'ERASE_CONFIRMATION_REQUIRED',
      });
    }
    const actor = await this.requireActor(actorId);
    if (schoolId) await this.requireSchoolAccess(actor, schoolId);

    const target = await this.requireTarget(targetUserId);
    this.assertWithinRemit(actor, target);

    if (target.id === actor.id) {
      throw new ForbiddenException({
        message: 'You cannot delete your own account.',
        error: 'Forbidden',
        code: 'SELF_TARGET_FORBIDDEN',
      });
    }
    if (target.role === 'PLATFORM_ADMIN') {
      await this.requireAnotherPlatformAdmin(target.id);
    }

    const erased = await this.purge.eraseUser(target.id);
    if (!erased) {
      throw new NotFoundException('User not found');
    }
    // Sessions are gone with the row; an open socket is not, and a deleted
    // account must stop being able to act the moment it is deleted.
    this.realtime.disconnectUser(target.id);

    await this.auditService.log({
      actorId,
      action: 'user.erased',
      entity: 'User',
      entityId: target.id,
      meta: {
        targetRole: target.role,
        schoolId: target.schoolId,
        hadStudentProfile: erased.hadStudentProfile,
        removedCheckIns: erased.removedCheckIns,
        removedConversations: erased.removedConversations,
        initiatedVia: schoolId ? 'SCHOOL_ADMIN' : 'PLATFORM_ADMIN',
      },
      // The school that lost the account, not the actor's — a platform admin
      // erasing a student belongs in that student's school's trail.
      schoolId: target.schoolId,
    });

    this.logger.warn(
      `User ${target.id} (${target.role}) erased by admin ${actor.id}`,
    );
    return {
      id: target.id,
      erased: true,
      removedCheckIns: erased.removedCheckIns,
      removedConversations: erased.removedConversations,
    };
  }

  /**
   * Send the verification email again for an account that has not verified.
   * Idempotent from the caller's point of view: an already-verified account
   * reports that rather than sending a second link, so the admin surface can
   * show the truth instead of a green tick.
   */
  async resendVerificationEmail(
    actorId: string,
    targetUserId: string,
    schoolId: string | null,
  ) {
    const actor = await this.requireActor(actorId);
    if (schoolId) await this.requireSchoolAccess(actor, schoolId);

    const target = await this.requireTarget(targetUserId);
    this.assertWithinRemit(actor, target);

    if (target.emailVerified) {
      return { id: target.id, sent: false, alreadyVerified: true };
    }

    let sent = false;
    try {
      await this.authService.resendVerificationEmail(target.email);
      sent = true;
    } catch (error) {
      this.logger.warn(
        `Verification email for ${target.id} could not be sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.auditService.log({
      actorId,
      action: 'user.verification_email_resent',
      entity: 'User',
      entityId: target.id,
      meta: { targetRole: target.role, sent },
      schoolId: target.schoolId,
    });
    return { id: target.id, sent, alreadyVerified: false };
  }

  private async requireActor(actorId: string): Promise<Actor> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true, schoolId: true },
    });
    if (!actor) throw new ForbiddenException('Actor not found');
    return actor;
  }

  private async requireTarget(targetUserId: string): Promise<Target> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        email: true,
        role: true,
        schoolId: true,
        emailVerified: true,
      },
    });
    if (!target) throw new NotFoundException('User not found');
    return target;
  }

  /// Mirrors SchoolUsersService.requireSchoolAccess so both school surfaces
  /// answer the same way: platform admins anywhere, school admins only home.
  private async requireSchoolAccess(actor: Actor, schoolId: string) {
    if (actor.role === 'PLATFORM_ADMIN') return;
    if (actor.role === 'SCHOOL_ADMIN' && actor.schoolId === schoolId) return;
    throw new ForbiddenException({
      message: 'You do not have access to this school.',
      error: 'Forbidden',
      code: 'SCHOOL_ACCESS_DENIED',
    });
  }

  /**
   * The remit itself — asked of the actor and the target, never of the URL.
   * A school admin's authority ends at their school's members, and a platform
   * admin account is outside any school's reach.
   */
  private assertWithinRemit(actor: Actor, target: Target) {
    if (actor.role === 'PLATFORM_ADMIN') return;
    if (target.role === 'PLATFORM_ADMIN') {
      throw new ForbiddenException({
        message: 'Platform admin accounts cannot be managed from a school.',
        error: 'Forbidden',
        code: 'PLATFORM_ADMIN_TARGET_FORBIDDEN',
      });
    }
    if (!target.schoolId || target.schoolId !== actor.schoolId) {
      throw new ForbiddenException({
        message: 'This account does not belong to your school.',
        error: 'Forbidden',
        code: 'SCHOOL_ACCESS_DENIED',
      });
    }
  }

  /// Refusing to delete the last platform admin is the one lockout this
  /// surface cannot undo: with no admin left, no account can mint a new one.
  private async requireAnotherPlatformAdmin(targetUserId: string) {
    const remaining = await this.prisma.user.count({
      where: { role: 'PLATFORM_ADMIN', id: { not: targetUserId } },
    });
    if (remaining === 0) {
      throw new UnprocessableEntityException({
        message:
          'The last platform admin account cannot be deleted. Provision another first.',
        error: 'Unprocessable Entity',
        code: 'LAST_PLATFORM_ADMIN',
      });
    }
  }
}
