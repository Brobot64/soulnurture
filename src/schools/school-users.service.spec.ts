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
    account: { create: vi.fn(), updateMany: vi.fn() },
    studentProfile: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    professionalProfile: { create: vi.fn(), update: vi.fn() },
    session: { deleteMany: vi.fn() },
    chatThread: { count: vi.fn(), findMany: vi.fn() },
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
    it.each(['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] as const)(
      'creates a linked directory contact for an onboarded %s',
      async (role) => {
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
        role,
      });
      prisma.professionalProfile.create.mockResolvedValue({ id: 'profile-1' });
      authService.resendVerificationEmail.mockResolvedValue({});

      await service.onboardProfessional('admin-1', 'school-1', {
        email: 'kofi@example.com',
        name: 'Kofi Boateng',
        role,
        title: 'Head Counsellor',
      });

      expect(prisma.professionalProfile.create).toHaveBeenCalledWith({
        data: {
          userId: 'staff-1',
          title: 'Head Counsellor',
          department: null,
          available: true,
          supportPeople: {
            create: { name: 'Kofi Boateng', type: role, title: 'Head Counsellor' },
          },
        },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'school.professional_enrolled',
          meta: { schoolId: 'school-1', role },
        }),
      );
    });
  });

  describe('onboardSchoolAdmin', () => {
    const school = {
      id: 'school-1',
      name: 'Achimota School',
      shortCode: 'AS2345',
      status: 'ACTIVE',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      defaultPasswordHash: 'precomputed-scrypt-hash',
    };

    it('provisions a SCHOOL_ADMIN through the school default password and audits', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'PLATFORM_ADMIN',
        schoolId: null,
      });
      prisma.school.findUnique.mockResolvedValue(school);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'admin-2',
        name: 'Yaw Mensah',
        email: 'yaw@example.com',
        role: 'SCHOOL_ADMIN',
      });
      authService.resendVerificationEmail.mockResolvedValue({});

      const result = await service.onboardSchoolAdmin('owner-1', 'school-1', {
        name: 'Yaw Mensah',
        email: 'yaw@example.com',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          name: 'Yaw Mensah',
          email: 'yaw@example.com',
          phone: null,
          role: 'SCHOOL_ADMIN',
          schoolId: 'school-1',
          mustChangePassword: true,
          emailVerified: false,
        },
      });
      expect(prisma.account.create).toHaveBeenCalledWith({
        data: {
          userId: 'admin-2',
          providerId: 'credential',
          accountId: 'admin-2',
          password: 'precomputed-scrypt-hash',
        },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'owner-1',
          action: 'school.admin_enrolled',
          entity: 'User',
          entityId: 'admin-2',
          meta: { schoolId: 'school-1', role: 'SCHOOL_ADMIN' },
          schoolId: 'school-1',
        }),
      );
      expect(result.verificationEmailSent).toBe(true);
      expect(result.user).toEqual({
        id: 'admin-2',
        name: 'Yaw Mensah',
        email: 'yaw@example.com',
        role: 'SCHOOL_ADMIN',
      });
    });

    it('refuses provisioning until a school default password is set', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'PLATFORM_ADMIN',
        schoolId: null,
      });
      prisma.school.findUnique.mockResolvedValue({
        ...school,
        defaultPasswordHash: null,
      });

      const rejection = await rejectionOf(
        service.onboardSchoolAdmin('owner-1', 'school-1', {
          name: 'Yaw Mensah',
          email: 'yaw@example.com',
        }),
      );

      expect(rejection.getStatus()).toBe(422);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SCHOOL_DEFAULT_PASSWORD_REQUIRED',
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.user.findFirst.mockResolvedValue({
        id: 'staff-1',
        role: 'COUNSELLOR',
        studentProfile: null,
        professionalProfile: { id: 'profile-1' },
      });
    });

    it.each([' Kofi Boateng ', ''])(
      'syncs provided name %j only through the target professional relation',
      async (name) => {
        const result = await service.updateUser('admin-1', 'school-1', 'staff-1', {
          name,
        });

        expect(result).toEqual({ updated: true });
        expect(prisma.user.update).toHaveBeenCalledTimes(1);
        expect(prisma.user.update).toHaveBeenCalledWith({
          where: { id: 'staff-1' },
          data: {
            name: name.trim(),
            professionalProfile: {
              update: {
                supportPeople: {
                  updateMany: { where: {}, data: { name: name.trim() } },
                },
              },
            },
          },
        });
        expect(prisma.professionalProfile.update).not.toHaveBeenCalled();
        expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
        expect(prisma.studentProfile.update).not.toHaveBeenCalled();
      },
    );

    it.each([' Head Counsellor ', ''])(
      'syncs provided title %j only through the target profile relation',
      async (title) => {
        await service.updateUser('admin-1', 'school-1', 'staff-1', { title });

        expect(prisma.professionalProfile.update).toHaveBeenCalledTimes(1);
        expect(prisma.professionalProfile.update).toHaveBeenCalledWith({
          where: { userId: 'staff-1' },
          data: {
            title: title.trim(),
            supportPeople: {
              updateMany: { where: {}, data: { title: title.trim() } },
            },
          },
        });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
        expect(prisma.studentProfile.update).not.toHaveBeenCalled();
      },
    );

    it('omits nested contact writes for phone and department changes', async () => {
      await service.updateUser('admin-1', 'school-1', 'staff-1', {
        name: undefined,
        title: undefined,
        phone: ' +233123456789 ',
        department: ' Wellbeing ',
      });

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'staff-1' },
        data: { phone: '+233123456789' },
      });
      expect(prisma.professionalProfile.update).toHaveBeenCalledTimes(1);
      expect(prisma.professionalProfile.update).toHaveBeenCalledWith({
        where: { userId: 'staff-1' },
        data: { department: 'Wellbeing' },
      });
    });

    it('updates students without writing professional profiles or contacts', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'student-1',
        role: 'STUDENT',
        studentProfile: { id: 'student-profile-1' },
        professionalProfile: null,
      });

      await service.updateUser('admin-1', 'school-1', 'student-1', {
        name: ' Ama ',
        phone: ' +233123456789 ',
        classLabel: ' Form 2 ',
        preferredLanguage: ' en ',
        title: 'Ignored',
        department: 'Ignored',
      });

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'student-1' },
        data: { name: 'Ama', phone: '+233123456789' },
      });
      expect(prisma.studentProfile.update).toHaveBeenCalledWith({
        where: { userId: 'student-1' },
        data: { classLabel: 'Form 2', preferredLanguage: 'en' },
      });
      expect(prisma.professionalProfile.update).not.toHaveBeenCalled();
      expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
    });

    it('rejects access to another school before any writes', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-2',
      });

      const rejection = await rejectionOf(
        service.updateUser('admin-2', 'school-1', 'staff-1', {
          name: 'Changed Name',
          title: 'Changed Title',
        }),
      );

      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SCHOOL_ACCESS_DENIED',
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.professionalProfile.update).not.toHaveBeenCalled();
      expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
      expect(prisma.studentProfile.update).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('rejects a foreign user before any writes', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const rejection = await rejectionOf(
        service.updateUser('admin-1', 'school-1', 'foreign-user', {
          name: 'Changed Name',
          title: 'Changed Title',
        }),
      );

      expect(rejection.getStatus()).toBe(404);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'foreign-user', schoolId: 'school-1' },
        select: {
          id: true,
          role: true,
          studentProfile: { select: { id: true } },
          professionalProfile: { select: { id: true } },
        },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.professionalProfile.update).not.toHaveBeenCalled();
      expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
      expect(prisma.studentProfile.update).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('resetUserPassword', () => {
    function setUpAdminContext() {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        defaultPasswordHash: 'precomputed-scrypt-hash',
      });
      prisma.$transaction.mockResolvedValue([]);
    }

    it('resets the credential password to the school default, forces change, revokes sessions, audits', async () => {
      setUpAdminContext();
      prisma.user.findFirst.mockResolvedValue({
        id: 'u2',
        role: 'STUDENT',
        studentProfile: { id: 's1' },
        professionalProfile: null,
      });

      const result = await service.resetUserPassword('admin-1', 'school-1', 'u2');

      expect(result).toEqual({ id: 'u2', passwordReset: true });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.account.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u2', providerId: 'credential' },
        data: { password: 'precomputed-scrypt-hash' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { mustChangePassword: true },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u2' },
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'school.user_password_reset',
          entityId: 'u2',
          meta: { schoolId: 'school-1' },
        }),
      );
    });

    it('refuses the caller’s own account with SELF_TARGET_FORBIDDEN', async () => {
      setUpAdminContext();
      prisma.user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'SCHOOL_ADMIN',
        studentProfile: null,
        professionalProfile: null,
      });

      const rejection = await rejectionOf(
        service.resetUserPassword('admin-1', 'school-1', 'admin-1'),
      );

      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SELF_TARGET_FORBIDDEN',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a platform admin target with PLATFORM_ADMIN_TARGET_FORBIDDEN', async () => {
      setUpAdminContext();
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        role: 'PLATFORM_ADMIN',
        studentProfile: null,
        professionalProfile: null,
      });

      const rejection = await rejectionOf(
        service.resetUserPassword('admin-1', 'school-1', 'owner-1'),
      );

      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'PLATFORM_ADMIN_TARGET_FORBIDDEN',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s a user id that belongs to another school', async () => {
      setUpAdminContext();
      prisma.user.findFirst.mockResolvedValue(null);

      const rejection = await rejectionOf(
        service.resetUserPassword('admin-1', 'school-1', 'foreign-user'),
      );

      expect(rejection.getStatus()).toBe(404);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('settings', () => {
    it('returns the identity panel with hasDefaultPassword and no hash', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      const createdAt = new Date('2026-10-01T00:00:00Z');
      prisma.school.findUnique.mockResolvedValue({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        status: 'ACTIVE',
        createdAt,
        defaultPasswordHash: 'precomputed-scrypt-hash',
      });

      const result = await service.settings('admin-1', 'school-1');

      expect(result).toEqual({
        id: 'school-1',
        name: 'Achimota School',
        shortCode: 'AS2345',
        status: 'ACTIVE',
        createdAt,
        hasDefaultPassword: true,
      });
      expect(result).not.toHaveProperty('defaultPasswordHash');
    });
  });

  describe('listChatThreads', () => {
    it('maps the register shape with participants, stamps and last message', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });
      const createdAt = new Date('2026-10-09T08:00:00Z');
      const claimedAt = new Date('2026-10-09T08:05:00Z');
      const lastMessageAt = new Date('2026-10-09T08:10:00Z');
      prisma.chatThread.findMany.mockResolvedValue([
        {
          id: 't1',
          status: 'ACTIVE',
          createdAt,
          claimedAt,
          closedAt: null,
          student: { user: { id: 'u1', name: 'Ama' } },
          professional: { user: { id: 'u2', name: 'Ms. Ada' } },
          _count: { messages: 4 },
          messages: [{ createdAt: lastMessageAt }],
        },
        {
          id: 't2',
          status: 'PENDING',
          createdAt,
          claimedAt: null,
          closedAt: null,
          student: { user: { id: 'u3', name: 'Kofi' } },
          professional: null,
          _count: { messages: 1 },
          messages: [],
        },
      ]);

      const result = await service.listChatThreads('admin-1', 'school-1', 'ACTIVE', '500');

      const args = prisma.chatThread.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ schoolId: 'school-1', status: 'ACTIVE' });
      expect(args.take).toBe(100);
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(result.items).toEqual([
        {
          id: 't1',
          status: 'ACTIVE',
          createdAt,
          claimedAt,
          closedAt: null,
          student: { id: 'u1', name: 'Ama' },
          professional: { id: 'u2', name: 'Ms. Ada' },
          lastMessageAt,
          messageCount: 4,
        },
        {
          id: 't2',
          status: 'PENDING',
          createdAt,
          claimedAt: null,
          closedAt: null,
          student: { id: 'u3', name: 'Kofi' },
          professional: null,
          lastMessageAt: null,
          messageCount: 1,
        },
      ]);
    });

    it('rejects an unknown status filter', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.school.findUnique.mockResolvedValue({ id: 'school-1' });

      const rejection = await rejectionOf(
        service.listChatThreads('admin-1', 'school-1', 'ARCHIVED'),
      );

      expect(rejection.getStatus()).toBe(422);
      expect(prisma.chatThread.findMany).not.toHaveBeenCalled();
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

    it('refuses deactivating your own account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        role: 'SCHOOL_ADMIN',
        schoolId: 'school-1',
      });
      prisma.user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'SCHOOL_ADMIN',
        studentProfile: null,
        professionalProfile: null,
      });

      const rejection = await rejectionOf(
        service.deactivateUser('admin-1', 'school-1', 'admin-1'),
      );

      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'SELF_TARGET_FORBIDDEN',
      });
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
