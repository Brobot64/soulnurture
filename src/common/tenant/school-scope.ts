import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { STAFF_ROLES } from '../../users/dto/staff-bootstrap.dto.js';

/**
 * Tenant predicate for the student-owned tables (support flags, check-ins,
 * support requests). Tenancy is read through the student's account instead of
 * being copied onto the row, so a flag can never be stranded in a school the
 * student has left.
 */
export function inSchool(schoolId: string) {
  return { student: { user: { schoolId } } };
}

export function supportPeopleInSchool(schoolId: string): Prisma.SupportPersonWhereInput {
  return {
    active: true,
    professional: {
      user: { schoolId, deactivatedAt: null, role: { in: [...STAFF_ROLES] } },
    },
  };
}

/**
 * Resolve a staff actor's school. Every staff-facing read fails closed on
 * null: an account with no school is entitled to no tenant's data.
 */
export async function schoolOf(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { schoolId: true },
  });
  return user?.schoolId ?? null;
}
