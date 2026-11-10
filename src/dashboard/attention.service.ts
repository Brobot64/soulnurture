import { Injectable } from '@nestjs/common';
import { SupportFlagStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { REVIEWER_ROLES } from '../common/guards/roles.decorator.js';
import { inSchool } from '../common/tenant/school-scope.js';

/**
 * The indicator page's own "open" predicate, copied rather than re-derived: a
 * badge on a nav icon that disagrees with the number the page it decorates
 * prints is worse than no badge.
 */
const OPEN_FLAGS: SupportFlagStatus[] = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
];

/**
 * The same two conditions the pilot analytics count as an unfinished
 * onboarding: an account still on its bootstrap password, or one whose email
 * has never been confirmed. Both mean the person cannot actually sign in yet.
 */
function unfinishedSetup(schoolId: string | null) {
  return {
    deactivatedAt: null,
    ...(schoolId ? { schoolId } : {}),
    OR: [{ mustChangePassword: true }, { emailVerified: false }],
  };
}

export interface AttentionCounts {
  indicators: number | null;
  reports: number | null;
  roster: number | null;
}

/** `null` is not zero. It means the surface is not this actor's to open, so
 * the rail must draw nothing rather than a reassuring "0". */
const NOTHING: AttentionCounts = {
  indicators: null,
  reports: null,
  roster: null,
};

/**
 * One request for the whole staff rail. The alternative — each badge calling
 * its own list endpoint to read its own header — made the sidebar fan out to
 * every page in the app on every navigation, and forced each list to carry a
 * count it did not otherwise need.
 *
 * Requests and inbox unread deliberately do NOT live here: both already have
 * event-driven lanes (`support-requests:changed` and the socket's read
 * receipts) that update without a poll, and two sources of truth for one badge
 * is how a badge starts lying.
 */
@Injectable()
export class AttentionService {
  constructor(private readonly prisma: PrismaService) {}

  async counts(userId: string): Promise<AttentionCounts> {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, schoolId: true },
    });
    if (!actor || actor.role === UserRole.STUDENT) return NOTHING;

    const isReviewer = REVIEWER_ROLES.some((role) => role === actor.role);
    const isPlatformAdmin = actor.role === UserRole.PLATFORM_ADMIN;

    const [indicators, reports, roster] = await Promise.all([
      isReviewer && actor.schoolId
        ? this.prisma.supportFlag.count({
            where: {
              ...inSchool(actor.schoolId),
              status: { in: OPEN_FLAGS },
            },
          })
        : Promise.resolve(null),
      isReviewer && actor.schoolId
        ? this.prisma.aiResponseReport.count({
            where: {
              reviewOutcome: null,
              message: { conversation: inSchool(actor.schoolId) },
            },
          })
        : Promise.resolve(null),
      // Only the two rosters in the app list accounts the actor can act on,
      // and only they have the icon this badge decorates.
      isPlatformAdmin || actor.role === UserRole.SCHOOL_ADMIN
        ? this.prisma.user.count({
            where: unfinishedSetup(isPlatformAdmin ? null : actor.schoolId),
          })
        : Promise.resolve(null),
    ]);

    return { indicators, reports, roster };
  }
}
