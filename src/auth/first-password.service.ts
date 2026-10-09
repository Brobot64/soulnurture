import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hashPassword } from 'better-auth/crypto';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class FirstPasswordService {
  constructor(private readonly prisma: PrismaService) {}

  /// Forced first-time password set after school onboarding. No old password
  /// is involved — the account was created with the school's default
  /// credential, which this call replaces.
  async setFirstPassword(
    userId: string,
    currentSessionToken: string | undefined,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mustChangePassword: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mustChangePassword) {
      throw new ForbiddenException({
        message: 'This account is not awaiting a first password change.',
        error: 'Forbidden',
        code: 'PASSWORD_CHANGE_NOT_REQUIRED',
      });
    }

    const account = await this.prisma.account.findFirst({
      where: { userId, providerId: 'credential' },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Credential account not found');

    await this.prisma.account.update({
      where: { id: account.id },
      data: { password: await hashPassword(newPassword) },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { mustChangePassword: false },
    });
    // The session used for this change survives; every other device is cut.
    await this.prisma.session.deleteMany({
      where: {
        userId,
        ...(currentSessionToken ? { token: { not: currentSessionToken } } : {}),
      },
    });

    return { passwordChanged: true };
  }
}
