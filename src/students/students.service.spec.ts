import { Test, TestingModule } from '@nestjs/testing';
import { StudentsService } from './students.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('StudentsService', () => {
  it('builds a greeting from student name', async () => {
    const prisma = {
      studentProfile: {
        findUnique: () =>
          Promise.resolve({ firstName: 'Amina', displayName: 'Amina' }),
      },
      emotionalCheckIn: { findFirst: () => Promise.resolve(null) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    const service = module.get(StudentsService);
    const result = await service.getSanctuary('user-1');
    expect(result.greeting).toBe('Welcome back, Amina');
  });
});
