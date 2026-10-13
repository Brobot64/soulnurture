import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import {
  CheckInFeedbackService,
  moodEffect,
} from './check-in-feedback.service.js';

describe('CheckInFeedbackService', () => {
  let service: CheckInFeedbackService;
  let prisma: {
    emotionalCheckIn: Record<string, ReturnType<typeof vi.fn>>;
    checkInFeedback: Record<string, ReturnType<typeof vi.fn>>;
    school: Record<string, ReturnType<typeof vi.fn>>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  const checkIn = {
    id: 'checkin-1',
    studentId: student.id,
    feeling: 'STRESSED',
    intensity: 'A_LOT',
  };

  beforeEach(async () => {
    prisma = {
      emotionalCheckIn: { findUnique: vi.fn() },
      checkInFeedback: { create: vi.fn(), findUnique: vi.fn() },
      school: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckInFeedbackService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: {
            ensureProfile: vi.fn().mockResolvedValue(student),
          },
        },
      ],
    }).compile();

    service = module.get(CheckInFeedbackService);
  });

  describe('submit', () => {
    it('creates feedback linked to the check-in and student', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(checkIn);
      prisma.checkInFeedback.create.mockResolvedValue({
        id: 'fb-1',
        checkInId: checkIn.id,
        studentId: student.id,
        feeling: 'CALM',
        intensity: 'SOMEWHAT',
      });

      const result = await service.submit('user-1', checkIn.id, {
        feeling: 'CALM',
        intensity: 'SOMEWHAT',
      });

      expect(prisma.checkInFeedback.create).toHaveBeenCalledWith({
        data: {
          checkInId: checkIn.id,
          studentId: student.id,
          feeling: 'CALM',
          intensity: 'SOMEWHAT',
        },
      });
      expect(result.id).toBe('fb-1');
    });

    it('404s when the check-in does not exist', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(null);
      await expect(
        service.submit('user-1', checkIn.id, {
          feeling: 'CALM',
          intensity: 'SOMEWHAT',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.checkInFeedback.create).not.toHaveBeenCalled();
    });

    it('403s when the check-in belongs to another student', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue({
        ...checkIn,
        studentId: 'someone-else',
      });
      await expect(
        service.submit('user-1', checkIn.id, {
          feeling: 'CALM',
          intensity: 'SOMEWHAT',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.checkInFeedback.create).not.toHaveBeenCalled();
    });

    it('409s when feedback was already submitted for the check-in', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(checkIn);
      prisma.checkInFeedback.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '7',
        }),
      );
      await expect(
        service.submit('user-1', checkIn.id, {
          feeling: 'CALM',
          intensity: 'SOMEWHAT',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getForCheckIn', () => {
    it('returns the feedback for the students own check-in', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(checkIn);
      prisma.checkInFeedback.findUnique.mockResolvedValue({
        id: 'fb-1',
        checkInId: checkIn.id,
      });

      const result = await service.getForCheckIn('user-1', checkIn.id);

      expect(prisma.checkInFeedback.findUnique).toHaveBeenCalledWith({
        where: { checkInId: checkIn.id },
      });
      expect(result.feedback.id).toBe('fb-1');
    });

    it('returns null feedback when the student has not answered yet', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(checkIn);
      prisma.checkInFeedback.findUnique.mockResolvedValue(null);
      const result = await service.getForCheckIn('user-1', checkIn.id);
      expect(result.feedback).toBeNull();
    });

    it('404s for a missing check-in', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue(null);
      await expect(service.getForCheckIn('user-1', checkIn.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403s for another students check-in', async () => {
      prisma.emotionalCheckIn.findUnique.mockResolvedValue({
        ...checkIn,
        studentId: 'someone-else',
      });
      await expect(service.getForCheckIn('user-1', checkIn.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('moodEffectReport', () => {
    it('builds a CSV with before/after rows and the computed effect', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          feedback_id: 'fb-1',
          submitted_at: new Date('2026-10-13T10:00:00.000Z'),
          school_name: 'Miva High',
          student_name: 'Amina Okafor',
          student_email: 'amina@miva.edu.ng',
          check_in_id: checkIn.id,
          check_in_at: new Date('2026-10-13T09:30:00.000Z'),
          feeling_before: 'STRESSED',
          intensity_before: 'A_LOT',
          feeling_after: 'CALM',
          intensity_after: 'SOMEWHAT',
        },
      ]);

      const { csv, filename } = await service.moodEffectReport({
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(filename).toBe('soul-nurture-check-in-mood-2026-10-01_2026-10-31.csv');
      expect(csv).toContain(
        'feedbackId,submittedAt,school,studentName,studentEmail,checkInId,checkInAt,feelingBefore,intensityBefore,feelingAfter,intensityAfter,moodEffect',
      );
      expect(csv).toContain('fb-1');
      expect(csv).toContain('STRESSED');
      expect(csv).toContain('IMPROVED');
    });

    it('400s on a from/to window missing one side', async () => {
      await expect(
        service.moodEffectReport({ from: '2026-10-01' }),
      ).rejects.toThrow(/from and to must be provided together/);
    });

    it('404s on an unknown schoolId', async () => {
      prisma.school.findUnique.mockResolvedValue(null);
      await expect(
        service.moodEffectReport({
          schoolId: '11111111-2222-3333-4444-555555555555',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});

describe('moodEffect', () => {
  it('marks negative-to-positive swings as improved', () => {
    expect(
      moodEffect(
        { feeling: 'STRESSED', intensity: 'A_LOT' },
        { feeling: 'CALM', intensity: 'SOMEWHAT' },
      ),
    ).toBe('IMPROVED');
  });

  it('marks easing within the negative band as improved', () => {
    expect(
      moodEffect(
        { feeling: 'OVERWHELMED', intensity: 'A_LOT' },
        { feeling: 'ANXIOUS', intensity: 'A_LITTLE' },
      ),
    ).toBe('IMPROVED');
  });

  it('marks positive-to-negative swings as worsened', () => {
    expect(
      moodEffect(
        { feeling: 'HAPPY', intensity: 'SOMEWHAT' },
        { feeling: 'SAD_LOW', intensity: 'A_LITTLE' },
      ),
    ).toBe('WORSENED');
  });

  it('marks unchanged scores as same', () => {
    expect(
      moodEffect(
        { feeling: 'CALM', intensity: 'SOMEWHAT' },
        { feeling: 'HOPEFUL', intensity: 'SOMEWHAT' },
      ),
    ).toBe('SAME');
  });
});
