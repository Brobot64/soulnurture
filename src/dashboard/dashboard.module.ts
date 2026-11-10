import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { AttentionController } from './attention.controller.js';
import { AttentionService } from './attention.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DashboardController, AttentionController],
  providers: [DashboardService, AttentionService],
  exports: [DashboardService],
})
export class DashboardModule {}
