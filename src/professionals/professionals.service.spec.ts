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

  it.each([
    {},
    { department: 'Wellbeing' },
    { available: true },
    { available: false },
    {
      department: 'Wellbeing',
      available: false,
      title: undefined,
      imageUrl: undefined,
    },
  ])('omits contact writes for profile-only updates %j', async (dto) => {
    const updatedProfile = { id: 'prof-1', userId: 'user-1', ...dto };
    const prisma = {
      professionalProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: 'prof-1' }),
        update: vi.fn().mockResolvedValue(updatedProfile),
        create: vi.fn(),
      },
    };
    const service = await makeService(prisma);

    const result = await service.updateMe('user-1', dto);

    expect(result).toBe(updatedProfile);
    expect(prisma.professionalProfile.update).toHaveBeenCalledTimes(1);
    expect(prisma.professionalProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: dto,
    });
    expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'title only',
      dto: { title: ' Lead Counsellor ' },
      contactData: { title: ' Lead Counsellor ' },
    },
    {
      label: 'an empty title',
      dto: { title: '' },
      contactData: { title: '' },
    },
    {
      label: 'image only',
      dto: { imageUrl: 'https://cdn.example.com/staff/me.jpg' },
      contactData: { imageUrl: 'https://cdn.example.com/staff/me.jpg' },
    },
    {
      label: 'title and image alongside profile-only fields',
      dto: {
        title: 'Lead Counsellor',
        imageUrl: 'https://cdn.example.com/staff/me.jpg',
        department: 'Wellbeing',
        available: false,
      },
      contactData: {
        title: 'Lead Counsellor',
        imageUrl: 'https://cdn.example.com/staff/me.jpg',
      },
    },
  ])('syncs $label only through linked contacts', async ({ dto, contactData }) => {
    const updatedProfile = { id: 'prof-1', userId: 'user-1', ...dto };
    const prisma = {
      professionalProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: 'prof-1' }),
        update: vi.fn().mockResolvedValue(updatedProfile),
        create: vi.fn(),
      },
    };
    const service = await makeService(prisma);

    const result = await service.updateMe('user-1', dto);

    expect(result).toBe(updatedProfile);
    expect(prisma.professionalProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(prisma.professionalProfile.update).toHaveBeenCalledTimes(1);
    expect(prisma.professionalProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: {
        ...dto,
        supportPeople: {
          updateMany: { where: {}, data: contactData },
        },
      },
    });
    expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
  });

  it('rejects updating a missing user without any writes', async () => {
    const prisma = {
      professionalProfile: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update: vi.fn(),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = await makeService(prisma);

    await expect(
      service.updateMe('missing', {
        title: 'Lead Counsellor',
        imageUrl: 'https://cdn.example.com/staff/me.jpg',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.professionalProfile.create).not.toHaveBeenCalled();
    expect(prisma.professionalProfile.update).not.toHaveBeenCalled();
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