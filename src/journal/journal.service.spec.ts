import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StudentsService } from '../students/students.service.js';
import { JournalService } from './journal.service.js';

describe('JournalService', () => {
  let service: JournalService;
  let prisma: {
    journalEntry: Record<string, ReturnType<typeof vi.fn>>;
  };

  const student = {
    id: 'student-1',
    userId: 'user-1',
    firstName: 'Amina',
    preferredLanguage: 'en',
  };

  beforeEach(async () => {
    prisma = {
      journalEntry: {
        findMany: vi.fn(),
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StudentsService,
          useValue: { ensureProfile: vi.fn().mockResolvedValue(student) },
        },
      ],
    }).compile();

    service = module.get(JournalService);
  });

  it('creates a private entry for the student', async () => {
    prisma.journalEntry.create.mockResolvedValue({ id: 'j1' });
    await service.create('user-1', {
      title: 'Night',
      content: 'Today I felt calm.',
      prompt: 'How is your body feeling?',
    });
    expect(prisma.journalEntry.create).toHaveBeenCalledWith({
      data: {
        studentId: student.id,
        title: 'Night',
        content: 'Today I felt calm.',
        prompt: 'How is your body feeling?',
        private: true,
      },
    });
  });

  it('lists only the students own entries', async () => {
    prisma.journalEntry.findMany.mockResolvedValue([{ id: 'j1' }]);
    const result = await service.listMine('user-1');
    expect(prisma.journalEntry.findMany).toHaveBeenCalledWith({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toHaveLength(1);
  });

  it('throws NotFoundException for a missing entry', async () => {
    prisma.journalEntry.findUnique.mockResolvedValue(null);
    await expect(service.getOne('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('forbids reading another students entry', async () => {
    prisma.journalEntry.findUnique.mockResolvedValue({
      id: 'j1',
      studentId: 'student-2',
    });
    await expect(service.getOne('user-1', 'j1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('updates only editable fields for the owner', async () => {
    prisma.journalEntry.findUnique.mockResolvedValue({
      id: 'j1',
      studentId: student.id,
    });
    prisma.journalEntry.update.mockResolvedValue({ id: 'j1', title: 'Edited' });

    const result = await service.update('user-1', 'j1', { title: 'Edited' });

    expect(prisma.journalEntry.update).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { title: 'Edited' },
    });
    expect(result.title).toBe('Edited');
  });

  it('deletes an entry for the owner', async () => {
    prisma.journalEntry.findUnique.mockResolvedValue({
      id: 'j1',
      studentId: student.id,
    });
    prisma.journalEntry.delete.mockResolvedValue({ id: 'j1' });

    await service.delete('user-1', 'j1');

    expect(prisma.journalEntry.delete).toHaveBeenCalledWith({
      where: { id: 'j1' },
    });
  });
});