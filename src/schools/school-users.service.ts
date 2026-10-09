import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type UserRole } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import { generateStudentCode } from './short-code.js';

const CODE_RETRY_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class SchoolUsersService {
  private readonly logger = new Logger(SchoolUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  /// Platform admins manage every school; school admins only their own.
  /// The actor's role/school are read from the DB — never trusted from the
  /// request payload.
  async requireSchoolAccess(actorId: string, schoolId: string) {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { role: true, schoolId: true },
    });
    if (!actor) throw new ForbiddenException('Actor not found');
    if (actor.role === 'PLATFORM_ADMIN') return actor;
    if (actor.role === 'SCHOOL_ADMIN' && actor.schoolId === schoolId) {
      return actor;
    }
    throw new ForbiddenException({
      message: 'You do not have access to this school.',
      error: 'Forbidden',
      code: 'SCHOOL_ACCESS_DENIED',
    });
  }

  async overview(actorId: string, schoolId: string) {
    await this.requireSchoolAccess(actorId, schoolId);
    await this.requireSchool(schoolId);

    const [students, professionals, totalUsers, pendingChatRequests] =
      await Promise.all([
        this.prisma.user.count({ where: { schoolId, role: 'STUDENT' } }),
        this.prisma.user.count({
          where: { schoolId, role: { in: [...STAFF_ROLES] } },
        }),
        this.prisma.user.count({ where: { schoolId } }),
        this.prisma.chatThread.count({ where: { schoolId, status: 'PENDING' } }),
      ]);
    return { students, professionals, totalUsers, pendingChatRequests };
  }

  async listUsers(actorId: string, schoolId: string, role?: string) {
    await this.requireSchoolAccess(actorId, schoolId);
    await this.requireSchool(schoolId);

    const where: Prisma.UserWhereInput = { schoolId };
    if (role) {
      if (!(STAFF_ROLES as readonly string[]).includes(role) && role !== 'STUDENT' && role !== 'SCHOOL_ADMIN') {
        throw new UnprocessableEntityException('Unknown role filter');
      }
      where.role = role as UserRole;
    }

    const items = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        emailVerified: true,
        mustChangePassword: true,
        deactivatedAt: true,
        createdAt: true,
        studentProfile: {
          select: {
            studentCode: true,
            firstName: true,
            lastName: true,
            classLabel: true,
            preferredLanguage: true,
          },
        },
        professionalProfile: {
          select: { title: true, department: true, available: true },
        },
      },
    });
    return { items };
  }

  async onboardStudent(
    actorId: string,
    schoolId: string,
    input: {
      email: string;
      firstName: string;
      lastName?: string;
      classLabel?: string;
      phone?: string;
      preferredLanguage?: string;
    },
  ) {
    await this.requireSchoolAccess(actorId, schoolId);
    const school = await this.requireSchoolWithDefaults(schoolId);
    const defaultPasswordHash = this.requireDefaultPassword(school);
    const email = input.email.trim();
    await this.requireEmailAvailable(email);

    const fullName = [input.firstName, input.lastName].filter(Boolean).join(' ');
    const user = await this.createCredentialUser({
      name: fullName,
      email,
      phone: input.phone,
      role: 'STUDENT',
      schoolId,
      defaultPasswordHash,
    });

    const studentCode = await this.allocateStudentCode(school.shortCode);
    await this.prisma.studentProfile.create({
      data: {
        userId: user.id,
        firstName: input.firstName.trim(),
        lastName: input.lastName?.trim() ?? null,
        classLabel: input.classLabel?.trim() ?? null,
        studentCode,
        preferredLanguage: input.preferredLanguage?.trim() ?? 'en',
      },
    });

    const verificationEmailSent = await this.trySendVerificationEmail(email);
    await this.auditService.log({
      actorId,
      action: 'school.student_enrolled',
      entity: 'User',
      entityId: user.id,
      meta: { schoolId, studentCode },
    });
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      studentCode,
      verificationEmailSent,
    };
  }

  async onboardProfessional(
    actorId: string,
    schoolId: string,
    input: {
      email: string;
      name: string;
      role: (typeof STAFF_ROLES)[number];
      title?: string;
      department?: string;
    },
  ) {
    await this.requireSchoolAccess(actorId, schoolId);
    const school = await this.requireSchoolWithDefaults(schoolId);
    const defaultPasswordHash = this.requireDefaultPassword(school);
    const email = input.email.trim();
    await this.requireEmailAvailable(email);

    const user = await this.createCredentialUser({
      name: input.name.trim(),
      email,
      role: input.role,
      schoolId,
      defaultPasswordHash,
    });

    await this.prisma.professionalProfile.create({
      data: {
        userId: user.id,
        title: input.title?.trim() ?? null,
        department: input.department?.trim() ?? null,
        available: true,
      },
    });

    const verificationEmailSent = await this.trySendVerificationEmail(email);
    await this.auditService.log({
      actorId,
      action: 'school.professional_enrolled',
      entity: 'User',
      entityId: user.id,
      meta: { schoolId, role: input.role },
    });
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      verificationEmailSent,
    };
  }

  async updateUser(
    actorId: string,
    schoolId: string,
    userId: string,
    input: {
      name?: string;
      phone?: string;
      classLabel?: string;
      preferredLanguage?: string;
      title?: string;
      department?: string;
    },
  ) {
    await this.requireSchoolAccess(actorId, schoolId);
    const target = await this.requireSchoolMember(schoolId, userId);

    if (input.name !== undefined || input.phone !== undefined) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.phone !== undefined ? { phone: input.phone.trim() } : {}),
        },
      });
    }
    if (
      target.studentProfile &&
      (input.classLabel !== undefined || input.preferredLanguage !== undefined)
    ) {
      await this.prisma.studentProfile.update({
        where: { userId },
        data: {
          ...(input.classLabel !== undefined
            ? { classLabel: input.classLabel.trim() }
            : {}),
          ...(input.preferredLanguage !== undefined
            ? { preferredLanguage: input.preferredLanguage.trim() }
            : {}),
        },
      });
    }
    if (
      target.professionalProfile &&
      (input.title !== undefined || input.department !== undefined)
    ) {
      await this.prisma.professionalProfile.update({
        where: { userId },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.department !== undefined
            ? { department: input.department.trim() }
            : {}),
        },
      });
    }

    await this.auditService.log({
      actorId,
      action: 'school.user_updated',
      entity: 'User',
      entityId: userId,
      meta: { schoolId },
    });
    return { updated: true };
  }

  /// Soft-remove: the account stays (chat history, audit trail) but loses
  /// every session immediately and cannot sign in again (sign-in guard +
  /// TenantGuard) until reactivation.
  async deactivateUser(actorId: string, schoolId: string, userId: string) {
    await this.requireSchoolAccess(actorId, schoolId);
    await this.requireSchoolMember(schoolId, userId);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { deactivatedAt: new Date() },
      }),
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);
    await this.auditService.log({
      actorId,
      action: 'school.user_deactivated',
      entity: 'User',
      entityId: userId,
      meta: { schoolId },
    });
    return { id: userId, deactivated: true };
  }

  async reactivateUser(actorId: string, schoolId: string, userId: string) {
    await this.requireSchoolAccess(actorId, schoolId);
    await this.requireSchoolMember(schoolId, userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt: null },
    });
    await this.auditService.log({
      actorId,
      action: 'school.user_reactivated',
      entity: 'User',
      entityId: userId,
      meta: { schoolId },
    });
    return { id: userId, deactivated: false };
  }

  async updateSettings(
    actorId: string,
    schoolId: string,
    input: { defaultPassword: string },
  ) {
    await this.requireSchoolAccess(actorId, schoolId);
    await this.requireSchool(schoolId);

    await this.prisma.school.update({
      where: { id: schoolId },
      data: { defaultPasswordHash: await hashPassword(input.defaultPassword) },
    });
    await this.auditService.log({
      actorId,
      action: 'school.settings_updated',
      entity: 'School',
      entityId: schoolId,
      meta: { defaultPasswordUpdated: true },
    });
    return { defaultPasswordUpdated: true };
  }

  private async requireSchool(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  private async requireSchoolWithDefaults(schoolId: string) {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, shortCode: true, defaultPasswordHash: true },
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  private requireDefaultPassword(school: { defaultPasswordHash: string | null }) {
    if (!school.defaultPasswordHash) {
      throw new UnprocessableEntityException({
        message:
          'Set the school default password in settings before onboarding users.',
        error: 'Unprocessable Entity',
        code: 'SCHOOL_DEFAULT_PASSWORD_REQUIRED',
      });
    }
    return school.defaultPasswordHash;
  }

  private async requireEmailAvailable(email: string) {
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new UnprocessableEntityException(
        'An account with this email already exists.',
      );
    }
  }

  private async requireSchoolMember(schoolId: string, userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, schoolId },
      select: {
        id: true,
        studentProfile: { select: { id: true } },
        professionalProfile: { select: { id: true } },
      },
    });
    if (!target) throw new NotFoundException('User not found in this school');
    return target;
  }

  /// School accounts are created with the school's precomputed scrypt hash —
  /// no plaintext ever touches this path — and mustChangePassword forces the
  /// personal-password screen at first sign-in.
  private async createCredentialUser(input: {
    name: string;
    email: string;
    phone?: string;
    role: UserRole;
    schoolId: string;
    defaultPasswordHash: string;
  }) {
    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          phone: input.phone?.trim() || null,
          role: input.role,
          schoolId: input.schoolId,
          mustChangePassword: true,
          emailVerified: false,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Email or phone number already in use');
      }
      throw error;
    }

    // Better Auth credential model: providerId='credential',
    // accountId=<user id> (see UsersService.provisionAdmin).
    await this.prisma.account.create({
      data: {
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: input.defaultPasswordHash,
      },
    });
    return user;
  }

  private async allocateStudentCode(shortCode: string) {
    for (let attempt = 0; attempt < CODE_RETRY_ATTEMPTS; attempt += 1) {
      const candidate = generateStudentCode(shortCode);
      const clash = await this.prisma.studentProfile.findUnique({
        where: { studentCode: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    throw new ConflictException('Could not allocate a unique student code');
  }

  private async trySendVerificationEmail(email: string) {
    try {
      await this.authService.resendVerificationEmail(email);
      return true;
    } catch (error) {
      this.logger.warn(
        `Verification email for ${email} could not be sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
