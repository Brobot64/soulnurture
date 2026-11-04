import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { HistoryController } from './history.controller.js';
import { HistoryDeletionService } from './history-deletion.service.js';
import { HistoryPurgeService } from './history-purge.service.js';
import { HistoryService } from './history.service.js';

@Module({
  imports: [
    PrismaModule,
    StudentsModule,
    NotificationsModule,
    AuditModule,
  ],
  controllers: [HistoryController],
  providers: [HistoryService, HistoryDeletionService, HistoryPurgeService],
  exports: [HistoryService, HistoryDeletionService, HistoryPurgeService],
})
export class HistoryModule {}
