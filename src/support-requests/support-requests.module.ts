import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { SupportRequestsController } from './support-requests.controller.js';
import { SupportRequestsService } from './support-requests.service.js';

@Module({
  imports: [
    PrismaModule,
    StudentsModule,
    AuditModule,
    ChatModule,
    NotificationsModule,
  ],
  controllers: [SupportRequestsController],
  providers: [SupportRequestsService],
  exports: [SupportRequestsService],
})
export class SupportRequestsModule {}
