import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SchoolUsersService } from './school-users.service.js';

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {
  const rejection = await promise.then(
    () => null,
    (error) => error as HttpException,
  );
  if (!rejection) throw new Error('Expected the call to reject');
  return rejection;
}

describe('SchoolUsersService', () => {
  let service: SchoolUsersService;
  const prisma = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    school: { findUnique: vi.fn(), update: vi.fn() },
    account: { create: vi.fn() },
    studentProfile: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    professionalProfile: { create: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    chatThread: { count: vi.fn() },
    $transaction: vi.fn(),
  };
  const auditService = { log: vi.fn() };
  const authService = { resendVerificationEmail: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchoolUsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    service = module.get(SchoolUsersService);
  });

  describe('requireSchoolAccess', () => {
    it('rejects a school admin reaching another school with SCHOOL_ACCESS_DENIED', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-2',
      });

      const rejection = await rejectionOf(service.overview('admin-2', 'school-1'));

      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SCHOOL_ACCESS_DENIED',
      });
      expect(prisma.chatThread.count).not.toHaveBeenCalled();
    });

    it('lets a school admin into their own school', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
      prisma.user.count.mockResolvedValue(0);
      prisma.chatThread.count.mockResolvedValue(0);

      await expect(service.overview('admin-1', 'school-1')).resolves.toEqual({
        students: 0,
        professionals: 0,
        totalUsers: 0,
        pendingChatRequests: 0,
      });
    });

    it('lets a platform admin into any school', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'PLATFORM_ADMIN',
        schoolId: null,
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
      prisma.user.count.mockResolvedValue(0);
      prisma.chatThread.count.mockResolvedValue(0);

      await expect(service.overview('owner-1', 'school-1')).resolves.toBeDefined();
    });
  });

  describe('onboardStudent', () => {
    const school = {
      id: 'school-1',
      name: 'Achimota School',
      shortCode: 'AS2345',
      defaultPasswordHash: 'precomputed-scrypt-hash',
    };
    const onboardInput = { email: 'ama@example.com', firstName: 'Ama' };

    function setUpHappyPath() {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue(school);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'student-1',
        name: 'Ama',
        email: 'ama@example.com',
        role: 'STUDENT',
      });
      prisma.studentProfile.findUnique.mockResolvedValue(null);
      prisma.studentProfile.create.mockResolvedValue({ id: 'profile-1' });
      authService.resendVerificationEmail.mockResolvedValue({});
    }

    it('creates the credential account with the school hash and forces a password change', async () => {
      setUpHappyPath();

      const result = await service.onboardStudent(
        'admin-1',
        'school-1',
        onboardInput,
      );

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          name: 'Ama',
          email: 'ama@example.com',
          phone: null,
          role: 'STUDENT',
          schoolId: 'school-1',
          mustChangePassword: true,
          emailVerified: false,
        },
      });
      const account = prisma.account.create.mock.calls[0][0].data;
      expect(account.providerId).toBe('credential');
      expect(account.accountId).toBe('student-1');
      expect(account.password).toBe('precomputed-scrypt-hash');

      expect(prisma.studentProfile.create).toHaveBeenCalledWith({
        data: {
          userId: 'student-1',
          firstName: 'Ama',
          lastName: null,
          classLabel: null,
          studentCode: expect.stringMatching(/^AS2345-\d{4}$/),
          preferredLanguage: 'en',
        },
      });
      expect(result.studentCode).toMatch(/^AS2345-\d{4}$/);
      expect(result.verificationEmailSent).toBe(true);
      expect(authService.resendVerificationEmail).toHaveBeenCalledWith(
        'ama@example.com',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          action: 'school.student_enrolled',
          entityId: 'student-1',
          meta: { schoolId: 'school-1', studentCode: result.studentCode },
        }),
      );
    });

    it('refuses onboarding until a school default password is set', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({
        ...school,
        defaultPasswordHash: null,
      });

      const rejection = await rejectionOf(
        service.onboardStudent('admin-1', 'school-1', onboardInput),
      );

      expect(rejection.getStatus()).toBe(422);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SCHOOL_DEFAULT_PASSWORD_REQUIRED',
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects an email that already has an account', async () => {
      setUpHappyPath();
      prisma.user.findFirst.mockResolvedValue({ id: 'existing-user' });

      const rejection = await rejectionOf(
        service.onboardStudent('admin-1', 'school-1', onboardInput),
      );

      expect(rejection.getStatus()).toBe(422);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(authService.resendVerificationEmail).not.toHaveBeenCalled();
    });

    it('maps a race-time unique conflict to 409 without leaving an account', async () => {
      setUpHappyPath();
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const rejection = await rejectionOf(
        service.onboardStudent('admin-1', 'school-1', onboardInput),
      );

      expect(rejection.getStatus()).toBe(409);
      expect(prisma.account.create).not.toHaveBeenCalled();
      expect(prisma.studentProfile.create).not.toHaveBeenCalled();
    });

    it('retries student-code allocation on a clash', async () => {
      setUpHappyPath();
      prisma.studentProfile.findUnique
        .mockResolvedValueOnce({ id: 'clash' })
        .mockResolvedValueOnce(null);

      await service.onboardStudent('admin-1', 'school-1', onboardInput);

      expect(prisma.studentProfile.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.studentProfile.create).toHaveBeenCalledTimes(1);
    });

    it('still onboards when the verification email cannot be sent', async () => {
      setUpHappyPath();
      authService.resendVerificationEmail.mockRejectedValue(
        new Error('smtp down'),
      );

      const result = await service.onboardStudent(
        'admin-1',
        'school-1',
        onboardInput,
      );

      expect(result.verificationEmailSent).toBe(false);
      expect(prisma.studentProfile.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('onboardProfessional', () => {
    it('creates the professional profile with availability on', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        defaultPasswordHash: 'precomputed-scrypt-hash',
      });
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'staff-1',
        name: 'Kofi Boateng',
        email: 'kofi@example.com',
        role: 'COUNSELLOR',
      });
      prisma.professionalProfile.create.mockResolvedValue({ id: 'profile-1' });
      authService.resendVerificationEmail.mockResolvedValue({});

      await service.onboardProfessional('admin-1', 'school-1', {
        email: 'kofi@example.com',
        name: 'Kofi Boateng',
        role: 'COUNSELLOR',
        title: 'Head Counsellor',
      });

      expect(prisma.professionalProfile.create).toHaveBeenCalledWith({
        data: {
          userId: 'staff-1',
          title: 'Head Counsellor',
          department: null,
          available: true,
        },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'school.professional_enrolled',
          meta: { schoolId: 'school-1', role: 'COUNSELLOR' },
        }),
      );
    });
  });

  describe('deactivateUser', () => {
    it('stamps deactivatedAt and revokes every session in one transaction', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.user.findFirst.mockResolvedValue({
        id: 'u2',
        studentProfile: null,
        professionalProfile: null,
      });
      prisma.$transaction.mockResolvedValue([]);

      const result = await service.deactivateUser('admin-1', 'school-1', 'u2');

      expect(result).toEqual({ id: 'u2', deactivated: true });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { deactivatedAt: expect.any(Date) },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u2' },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'school.user_deactivated',
          entityId: 'u2',
        }),
      );
    });

    it('404s a user who is not a member of the school', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.user.findFirst.mockResolvedValue(null);

      const rejection = await rejectionOf(
        service.deactivateUser('admin-1', 'school-1', 'foreign-user'),
      );

      expect(rejection.getStatus()).toBe(404);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateSettings', () => {
    it('stores only a scrypt hash of the new default password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
      prisma.school.update.mockResolvedValue({ id: 'school-1' });

      const result = await service.updateSettings('admin-1', 'school-1', {
        defaultPassword: 'brand-new-secret',
      });

      expect(result).toEqual({ defaultPasswordUpdated: true });
      const hash = prisma.school.update.mock.calls[0][0].data.defaultPasswordHash;
      expect(typeof hash).toBe('string');
      expect(hash).not.toContain('brand-new-secret');
      expect(JSON.stringify(prisma.school.update.mock.calls)).not.toContain(
        'brand-new-secret',
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'school.settings_updated' }),
      );
    });
  });

  describe('listUsers', () => {
    it('caps take and filters by role', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.listUsers('admin-1', 'school-1', 'STUDENT');

      expect(result).toEqual({ items: [] });
      const args = prisma.user.findMany.mock.calls[0][0];
      expect(args.take).toBe(200);
      expect(args.where).toEqual({ schoolId: 'school-1', role: 'STUDENT' });
    });

    it('rejects an unknown role filter', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });

      const rejection = await rejectionOf(
        service.listUsers('admin-1', 'school-1', 'PRINCIPAL'),
      );

      expect(rejection.getStatus()).toBe(422);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
