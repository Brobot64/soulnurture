import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SchoolsModule } from '../schools/schools.module.js';
import { AdminAnalyticsController } from './admin-analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { SchoolAnalyticsController } from './school-analytics.controller.js';

@Module({
  imports: [PrismaModule, SchoolsModule],
  controllers: [AdminAnalyticsController, SchoolAnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
