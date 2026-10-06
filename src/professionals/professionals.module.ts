import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProfessionalsController } from './professionals.controller.js';
import { ProfessionalsService } from './professionals.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [ProfessionalsController],
  providers: [ProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
