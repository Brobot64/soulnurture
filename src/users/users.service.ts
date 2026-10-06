import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type UserRole } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { STAFF_ROLES } from './dto/staff-bootstrap.dto.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async provisionAdmin(input: {
    email: string;
    name: string;
    role: UserRole;
    phone?: string;
    password: string;
  }) {
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: input.email.trim(), mode: 'insensitive' } },
    });
    if (existing) throw new Error('User already exists');

    const user = await this.prisma.user.create({
      data: {
        name: input.name,
        email: input.email.trim(),
        phone: input.phone ?? null,
        role: input.role,
        emailVerified: true,
      },
      include: { studentProfile: true, professionalProfile: true },
    });

    // Better Auth credential model: sign-in looks the account up by
    // providerId='credential' and accountId=<user id>.
    await this.prisma.account.create({
      data: {
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: await hashPassword(input.password),
      },
    });

    if (input.role !== 'STUDENT') {
      await this.prisma.professionalProfile.create({
        data: {
          userId: user.id,
          available: true,
        },
      });
    }
    return user;
  }

  /**
   * Secret-gated enrolment for the first professional accounts.
   * Public sign-up (Better Auth) always creates STUDENT accounts; staff roles
   * enter the system here using STAFF_BOOTSTRAP_KEY, or via provisionAdmin
   * once an existing staff member can provision them.
   * Password is hashed with Better Auth's credential hasher so sign-in works;
   * email verification reuses the normal Better Auth verification flow.
   */
  async bootstrapStaff(input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    role: UserRole;
    enrollmentKey: string;
  }) {
    const configuredKey = this.config.get<string>('STAFF_BOOTSTRAP_KEY');
    if (!configuredKey) {
      throw new ForbiddenException('Staff enrolment is not enabled');
    }
    const provided = Buffer.from(input.enrollmentKey, 'utf8');
    const expected = Buffer.from(configuredKey, 'utf8');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new ForbiddenException('Invalid enrollment key');
    }
    if (!(STAFF_ROLES as readonly string[]).includes(input.role)) {
      throw new BadRequestException(
        'Enrolment only supports professional roles; students use public sign-up',
      );
    }

    const email = input.email.trim();
    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new UnprocessableEntityException(
        'An account with this email already exists.',
      );
    }

    const user = await this.prisma.user.create({
      data: {
        name: input.name.trim(),
        email,
        phone: input.phone ?? null,
        role: input.role,
        emailVerified: false,
      },
      include: { studentProfile: true, professionalProfile: true },
    });

    // Better Auth credential model (see provisionAdmin): credentials are
    // looked up by providerId='credential' + accountId=<user id>.
    await this.prisma.account.create({
      data: {
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: await hashPassword(input.password),
      },
    });

    await this.prisma.professionalProfile.create({
      data: { userId: user.id, available: true },
    });

    // Verification goes through Better Auth itself: in better-auth 1.7 the
    // verify-email endpoint validates an HS256 JWT signed with the auth
    // secret, and that token only exists inside the emailed link. AuthService
    // wraps Better Auth's internal send-verification-email (JWT creation plus
    // the configured mail hook), so bootstrap reuses the exact signup flow.
    let verificationEmailSent = true;
    try {
      await this.authService.resendVerificationEmail(email);
    } catch (error) {
      // The account exists; staff can hit POST /api/verification/resend, so
      // an SMTP hiccup must not abort the enrolment.
      verificationEmailSent = false;
      this.logger.warn(
        `Verification email for ${email} could not be sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.auditService.log({
      action: 'staff.bootstrap_enrollment',
      entity: 'User',
      entityId: user.id,
      meta: { role: input.role },
    });

    return { user, verificationEmailSent };
  }
}
