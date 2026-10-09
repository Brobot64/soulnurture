import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { StudentsModule } from '../students/students.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AiModule,
    NotificationsModule,
    RealtimeModule,
    StudentsModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
