import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SchoolsModule } from '../schools/schools.module.js';
import { AdminAnalyticsController } from './admin-analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { PilotAnalyticsController } from './pilot-analytics.controller.js';
import { PilotAnalyticsService } from './pilot-analytics.service.js';
import { SchoolAnalyticsController } from './school-analytics.controller.js';

@Module({
  imports: [PrismaModule, SchoolsModule],
  controllers: [
    AdminAnalyticsController,
    SchoolAnalyticsController,
    PilotAnalyticsController,
  ],
  providers: [AnalyticsService, PilotAnalyticsService],
})
export class AnalyticsModule {}
