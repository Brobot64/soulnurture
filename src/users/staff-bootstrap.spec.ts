import { BadRequestException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { hashPassword } from 'better-auth/crypto';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const ENROLLMENT_KEY = 'boot-key-123';

const bootstrapInput = {
  name: 'Eric Moore',
  email: 'eric.moore@school.org',
  password: 'eriMore123#',
  role: 'PSYCHOLOGIST' as const,
  enrollmentKey: ENROLLMENT_KEY,
};

const createdUser = {
  id: 'user-eric',
  name: 'Eric Moore',
  email: bootstrapInput.email,
  role: 'PSYCHOLOGIST',
};

describe('UsersService bootstrapStaff', () => {
  let service: UsersService;
  let prisma: {
    user: Record<string, ReturnType<typeof vi.fn>>;
    account: Record<string, ReturnType<typeof vi.fn>>;
    professionalProfile: Record<string, ReturnType<typeof vi.fn>>;
  };
  let config: { get: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };
  let authService: { resendVerificationEmail: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      user: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      account: { create: vi.fn().mockResolvedValue({ id: 'acct-1' }) },
      professionalProfile: {
        create: vi.fn().mockResolvedValue({ id: 'prof-1' }),
      },
    };
    config = { get: vi.fn().mockReturnValue(ENROLLMENT_KEY) };
    auditService = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
    authService = { resendVerificationEmail: vi.fn().mockResolvedValue({ status: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: AuditService, useValue: auditService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  it('refuses while no enrolment key is configured', async () => {
    config.get.mockReturnValue(undefined);
    await expect(service.bootstrapStaff(bootstrapInput)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects a wrong enrolment key without creating anything', async () => {
    await expect(
      service.bootstrapStaff({ ...bootstrapInput, enrollmentKey: 'wrong-key' }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('refuses student roles (public sign-up covers students)', async () => {
    await expect(
      service.bootstrapStaff({
        ...bootstrapInput,
        role: 'STUDENT' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('flags duplicate emails as unprocessable, like public sign-up', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(service.bootstrapStaff(bootstrapInput)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('creates a hashed-credential, professional-profiled account needing verification', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(createdUser);

    const result = await service.bootstrapStaff(bootstrapInput);

    const createCall = prisma.user.create.mock.calls[0][0] as {
      data: { role: string; emailVerified: boolean };
    };
    expect(createCall.data.role).toBe('PSYCHOLOGIST');
    expect(createCall.data.emailVerified).toBe(false);
    expect(prisma.account.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerId: 'credential',
        accountId: createdUser.id,
        password: expect.not.stringMatching(bootstrapInput.password),
      }),
    });
    expect(prisma.professionalProfile.create).toHaveBeenCalledWith({
      data: { userId: createdUser.id, available: true },
    });
    const hashedOk = await hashPassword(bootstrapInput.password);
    expect(hashedOk).not.toBe(bootstrapInput.password);

    expect(authService.resendVerificationEmail).toHaveBeenCalledWith(
      bootstrapInput.email,
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff.bootstrap_enrollment' }),
    );
    expect(result.user).toEqual(createdUser);
    expect(result.verificationEmailSent).toBe(true);
  });

  it('survives an SMTP outage without aborting enrolment', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(createdUser);
    authService.resendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

    const result = await service.bootstrapStaff(bootstrapInput);

    expect(result.verificationEmailSent).toBe(false);
    expect(authService.resendVerificationEmail).toHaveBeenCalledWith(
      bootstrapInput.email,
    );
  });
});
