import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdateProfessionalDto } from './dto/update-professional.dto.js';

@Injectable()
export class ProfessionalsService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureProfile(userId: string) {
    const existing = await this.prisma.professionalProfile.findUnique({
      where: { userId },
    });
    if (existing) return existing;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.professionalProfile.create({
      data: { userId },
    });
  }

  getMe(userId: string) {
    return this.ensureProfile(userId);
  }

  async updateMe(userId: string, dto: UpdateProfessionalDto) {
    await this.ensureProfile(userId);
    return this.prisma.professionalProfile.update({
      where: { userId },
      data: dto,
    });
  }
}