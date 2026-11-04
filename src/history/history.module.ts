import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { HistoryController } from './history.controller.js';
import { HistoryDeletionService } from './history-deletion.service.js';
import { HistoryService } from './history.service.js';

@Module({
  imports: [PrismaModule, StudentsModule, NotificationsModule],
  controllers: [HistoryController],
  providers: [HistoryService, HistoryDeletionService],
  exports: [HistoryService, HistoryDeletionService],
})
export class HistoryModule {}
