import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { ActivitiesController } from './activities.controller.js';
import { ActivitySessionsController } from './activity-sessions.controller.js';
import { ActivitiesService } from './activities.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [ActivitiesController, ActivitySessionsController],
  providers: [ActivitiesService],
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
