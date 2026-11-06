import { HttpException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { HistoryPurgeService } from '../history/history-purge.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { UserErasureService } from './user-erasure.service.js';

async function rejectionOf(promise: Promise<unknown>): Promise<HttpException> {  const rejection = await promise.then(
    () => null,
    (error) => error as HttpException,
  );
  if (!rejection) throw new Error('Expected the call to reject');
  return rejection;
}

type Row = {
  id: string;
  email?: string;
  role?: string;
  schoolId?: string | null;
  emailVerified?: boolean;
};

describe('UserErasureService', () => {
  let service: UserErasureService;
  const prisma = {
    user: { findUnique: vi.fn(), count: vi.fn() },
  };
  const auditService = { log: vi.fn() };
  const realtime = { disconnectUser: vi.fn() };
  const purge = { eraseUser: vi.fn() };
  const authService = { resendVerificationEmail: vi.fn() };

  const platformAdmin = {
    id: 'admin-platform',
    role: 'PLATFORM_ADMIN',
    schoolId: null,
  };
  const schoolAdmin = {
    id: 'admin-1',
    role: 'SCHOOL_ADMIN',
    schoolId: 'school-1',
  };
  const studentInSchool1 = {
    id: 'student-1',
    email: 'a@example.com',
    role: 'STUDENT',
    schoolId: 'school-1',
    emailVerified: false,
  };

  beforeEach(async () => {
    // resetAllMocks, not clearAllMocks: the per-test `mockResolvedValueOnce`
    // queues would otherwise carry over and hand the next test the previous
    // test's actor/target rows.
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserErasureService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: auditService },
        { provide: RealtimeService, useValue: realtime },
        { provide: HistoryPurgeService, useValue: purge },
        { provide: AuthService, useValue: authService },
      ],
    }).compile();
    service = module.get(UserErasureService);
  });

  const erase = (actor: Row, target: Row, schoolId: string | null) => {
    prisma.user.findUnique
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce(target);
    return service.erase(actor.id, target.id, schoolId, true);
  };

  describe('erase', () => {
    it('refuses to run without the explicit confirmation', async () => {
      const rejection = await rejectionOf(
        service.erase('admin-1', 'student-1', 'school-1', false),
      );
      expect(rejection.getStatus()).toBe(422);
      expect(rejection.getResponse()).toMatchObject({
        code: 'ERASE_CONFIRMATION_REQUIRED',
      });
      expect(purge.eraseUser).not.toHaveBeenCalled();
    });

    it('lets a platform admin erase any account, logging into that school’s trail', async () => {
      purge.eraseUser.mockResolvedValue({
        role: 'STUDENT',
        schoolId: 'school-9',
        hadStudentProfile: true,
        removedCheckIns: 4,
        removedConversations: 2,
      });

      const result = await erase(platformAdmin, {
        ...studentInSchool1,
        schoolId: 'school-9',
      }, null);

      expect(purge.eraseUser).toHaveBeenCalledWith('student-1');
      expect(realtime.disconnectUser).toHaveBeenCalledWith('student-1');
      expect(result).toMatchObject({ erased: true, removedCheckIns: 4 });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-platform',
          action: 'user.erased',
          entityId: 'student-1',
          // the actor’s own remit is not the tenant the event happened in
          schoolId: 'school-9',
        }),
      );
    });

    it('lets a school admin erase a member of their own school', async () => {
      purge.eraseUser.mockResolvedValue({
        role: 'STUDENT',
        schoolId: 'school-1',
        hadStudentProfile: true,
        removedCheckIns: 0,
        removedConversations: 0,
      });

      await expect(erase(schoolAdmin, studentInSchool1, 'school-1')).resolves.toMatchObject({
        erased: true,
      });
    });

    it('refuses a school admin reaching another school, and erases nothing', async () => {
      const rejection = await rejectionOf(
        erase(schoolAdmin, { ...studentInSchool1, schoolId: 'school-2' }, 'school-2'),
      );
      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({ code: 'SCHOOL_ACCESS_DENIED' });
      expect(purge.eraseUser).not.toHaveBeenCalled();
    });

    it('refuses a school route whose path is not the caller’s school', async () => {
      const rejection = await rejectionOf(
        erase(schoolAdmin, studentInSchool1, 'school-2'),
      );
      expect(rejection.getStatus()).toBe(403);
      expect(purge.eraseUser).not.toHaveBeenCalled();
    });

    it('puts platform admins outside a school’s remit', async () => {
      const rejection = await rejectionOf(
        erase(schoolAdmin, { ...platformAdmin, email: 'o@example.com', emailVerified: true }, 'school-1'),
      );
      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({
        code: 'PLATFORM_ADMIN_TARGET_FORBIDDEN',
      });
    });

    it('refuses the caller’s own account', async () => {
      const rejection = await rejectionOf(erase(schoolAdmin, schoolAdmin, 'school-1'));
      expect(rejection.getStatus()).toBe(403);
      expect(rejection.getResponse()).toMatchObject({ code: 'SELF_TARGET_FORBIDDEN' });
    });

    it('refuses to erase the last platform admin', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(platformAdmin)
        .mockResolvedValueOnce({
          id: 'admin-other',
          email: 'b@example.com',
          role: 'PLATFORM_ADMIN',
          schoolId: null,
          emailVerified: true,
        });
      prisma.user.count.mockResolvedValue(0);

      const rejection = await rejectionOf(
        service.erase('admin-platform', 'admin-other', null, true),
      );
      expect(rejection.getStatus()).toBe(422);
      expect(rejection.getResponse()).toMatchObject({ code: 'LAST_PLATFORM_ADMIN' });
      expect(purge.eraseUser).not.toHaveBeenCalled();
    });

    it('404s an id that is not in the system', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(platformAdmin).mockResolvedValueOnce(null);
      await expect(
        service.erase('admin-platform', 'gone', null, true),
      ).rejects.toThrow();
      expect(purge.eraseUser).not.toHaveBeenCalled();
    });

    it('reports an already-erased account without a second deletion', async () => {
      purge.eraseUser.mockResolvedValue(null);
      const rejection = await rejectionOf(
        erase(platformAdmin, studentInSchool1, null),
      );
      expect(rejection.getStatus()).toBe(404);
      expect(realtime.disconnectUser).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('resendVerificationEmail', () => {
    it('mails an unverified account in the caller’s school and records it', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(schoolAdmin)
        .mockResolvedValueOnce(studentInSchool1);
      authService.resendVerificationEmail.mockResolvedValue({});

      await expect(
        service.resendVerificationEmail('admin-1', 'student-1', 'school-1'),
      ).resolves.toEqual({ id: 'student-1', sent: true, alreadyVerified: false });

      expect(authService.resendVerificationEmail).toHaveBeenCalledWith('a@example.com');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.verification_email_resent' }),
      );
    });

    it('sends nothing to an account that already verified', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(schoolAdmin)
        .mockResolvedValueOnce({ ...studentInSchool1, emailVerified: true });

      await expect(
        service.resendVerificationEmail('admin-1', 'student-1', 'school-1'),
      ).resolves.toEqual({ id: 'student-1', sent: false, alreadyVerified: true });

      expect(authService.resendVerificationEmail).not.toHaveBeenCalled();
    });

    it('answers sent:false when the mail fails, leaving the account alone', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(schoolAdmin)
        .mockResolvedValueOnce(studentInSchool1);
      authService.resendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

      await expect(
        service.resendVerificationEmail('admin-1', 'student-1', 'school-1'),
      ).resolves.toMatchObject({ sent: false });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ meta: expect.objectContaining({ sent: false }) }),
      );
    });

    it('refuses a school admin reaching another school’s account', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(schoolAdmin)
        .mockResolvedValueOnce({ ...studentInSchool1, schoolId: 'school-2' });

      const rejection = await rejectionOf(
        service.resendVerificationEmail('admin-1', 'student-1', 'school-1'),
      );
      expect(rejection.getStatus()).toBe(403);
      expect(authService.resendVerificationEmail).not.toHaveBeenCalled();
    });
  });
});
