import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { generateShortCode } from '../schools/short-code.js';

const CODE_RETRY_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  async createSchool(actorId: string, input: { name: string; defaultPassword?: string }) {
    const name = input.name.trim();
    const defaultPasswordHash = input.defaultPassword
      ? await hashPassword(input.defaultPassword)
      : null;

    let school: { id: string; name: string; shortCode: string; status: string } | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_ATTEMPTS && !school; attempt += 1) {
      try {
        school = await this.prisma.school.create({
          data: {
            name,
            shortCode: generateShortCode(name),
            defaultPasswordHash,
          },
          select: { id: true, name: true, shortCode: true, status: true },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    if (!school) {
      throw new ConflictException('Could not allocate a unique school short code');
    }

    await this.auditService.log({
      actorId,
      action: 'school.created',
      entity: 'School',
      entityId: school.id,
      meta: { name, hasDefaultPassword: defaultPasswordHash !== null },
    });
    return school;
  }

  async listSchools() {
    const schools = await this.prisma.school.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        shortCode: true,
        status: true,
        createdAt: true,
        _count: { select: { users: true } },
      },
    });
    return { items: schools };
  }

  async renameSchool(actorId: string, schoolId: string, name: string) {
    await this.requireSchool(schoolId);
    const school = await this.prisma.school.update({
      where: { id: schoolId },
      data: { name: name.trim() },
      select: { id: true, name: true, shortCode: true, status: true },
    });
    await this.auditService.log({
      actorId,
      action: 'school.renamed',
      entity: 'School',
      entityId: schoolId,
      meta: { name: school.name },
    });
    return school;
  }

  /// Suspending a school cuts every session it holds, so live users die on
  /// their next request (TenantGuard) — the sign-in guard blocks re-entry.
  /// Comms are best-effort and run after the state change commits: durable
  /// SCHOOL_SUSPENDED rows (so users see the reason in-app if the school is
  /// ever reactivated), then a hard socket disconnect — open sockets survive
  /// session revocation, and suspension must bite immediately.
  async suspendSchool(actorId: string, schoolId: string) {
    const school = await this.requireSchool(schoolId);
    if (school.status === 'SUSPENDED') return { id: schoolId, status: 'SUSPENDED' };

    const users = await this.prisma.user.findMany({
      where: { schoolId },
      select: { id: true },
    });

    await this.prisma.$transaction([
      this.prisma.school.update({
        where: { id: schoolId },
        data: { status: 'SUSPENDED' },
      }),
      this.prisma.session.deleteMany({ where: { user: { schoolId } } }),
    ]);

    await this.notifications.pushMany({
      userIds: users.map((user) => user.id),
      type: 'SCHOOL_SUSPENDED',
      title: 'School account suspended',
      body: 'Your school is currently suspended. Contact your school administrator.',
    });
    for (const user of users) {
      this.realtime.disconnectUser(user.id);
    }

    await this.auditService.log({
      actorId,
      action: 'school.suspended',
      entity: 'School',
      entityId: schoolId,
      meta: { revokedSessionsOf: users.length },
    });
    return { id: schoolId, status: 'SUSPENDED' };
  }

  async reactivateSchool(actorId: string, schoolId: string) {
    const school = await this.requireSchool(schoolId);
    if (school.status === 'ACTIVE') return { id: schoolId, status: 'ACTIVE' };

    await this.prisma.school.update({
      where: { id: schoolId },
      data: { status: 'ACTIVE' },
    });
    await this.auditService.log({
      actorId,
      action: 'school.reactivated',
      entity: 'School',
      entityId: schoolId,
    });
    return { id: schoolId, status: 'ACTIVE' };
  }

  async overview() {
    const now = Date.now();
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [
      schoolsTotal,
      schoolsActive,
      schoolsSuspended,
      usersTotal,
      students,
      professionals,
      admins,
      newLast7d,
      newLast30d,
      pendingRequests,
    ] = await Promise.all([
      this.prisma.school.count(),
      this.prisma.school.count({ where: { status: 'ACTIVE' } }),
      this.prisma.school.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: 'STUDENT' } }),
      this.prisma.user.count({
        where: { role: { in: ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] } },
      }),
      this.prisma.user.count({
        where: { role: { in: ['SCHOOL_ADMIN', 'PLATFORM_ADMIN'] } },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: last7d } } }),
      this.prisma.user.count({ where: { createdAt: { gte: last30d } } }),
      this.prisma.chatThread.count({ where: { status: 'PENDING' } }),
    ]);

    return {
      schools: {
        total: schoolsTotal,
        active: schoolsActive,
        suspended: schoolsSuspended,
      },
      users: {
        total: usersTotal,
        students,
        professionals,
        admins,
        newLast7d,
        newLast30d,
      },
      chat: { pendingRequests },
    };
  }

  async listUsers(limit?: string) {
    const take = Math.min(Number(limit ?? 50) || 50, 100);
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        school: { select: { id: true, name: true, shortCode: true } },
      },
    });
    return { items: users };
  }

  private async requireSchool(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, status: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }
}
