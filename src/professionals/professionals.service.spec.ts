import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProfessionalsService } from './professionals.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('ProfessionalsService', () => {
  it('returns an existing professional profile', async () => {
    const prisma = {
      professionalProfile: {
        findUnique: () => Promise.resolve({ id: 'prof-1', userId: 'user-1' }),
      },
    };
    const service = await makeService(prisma);
    const result = await service.getMe('user-1');
    expect(result).toEqual({ id: 'prof-1', userId: 'user-1' });
  });

  it('creates a profile on first access when none exists', async () => {
    const prisma = {
      professionalProfile: {
        findUnique: () => Promise.resolve(null),
        create: ({ data }: { data: { userId: string } }) =>
          Promise.resolve({ id: 'prof-1', ...data }),
      },
      user: {
        findUnique: () => Promise.resolve({ id: 'user-1', name: 'A. M.' }),
      },
    };
    const service = await makeService(prisma);
    const result = await service.getMe('user-1');
    expect(result).toEqual({ id: 'prof-1', userId: 'user-1' });
  });

  it('throws when the user does not exist', async () => {
    const prisma = {
      professionalProfile: {
        findUnique: () => Promise.resolve(null),
        create: () => Promise.resolve({}),
      },
      user: { findUnique: () => Promise.resolve(null) },
    };
    const service = await makeService(prisma);
    await expect(service.getMe('missing')).rejects.toThrow(NotFoundException);
  });

  it('updates a professional profile', async () => {
    const prisma = {
      professionalProfile: {
        findUnique: () => Promise.resolve({ id: 'prof-1' }),
        update: ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'prof-1', ...data }),
      },
    };
    const service = await makeService(prisma);
    const result = await service.updateMe('user-1', {
      title: 'Lead Counsellor',
      available: true,
    });
    expect(result).toMatchObject({ title: 'Lead Counsellor' });
  });

  async function makeService(prisma: unknown) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfessionalsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return module.get(ProfessionalsService);
  }
});