import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Tenant predicate for the student-owned tables (support flags, check-ins,
 * support requests). Tenancy is read through the student's account instead of
 * being copied onto the row, so a flag can never be stranded in a school the
 * student has left.
 */
export function inSchool(schoolId: string) {
  return { student: { user: { schoolId } } };
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
