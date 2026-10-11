import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConsentModule } from '../consent/consent.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { SupportFlagsModule } from '../support-flags/support-flags.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [
    PrismaModule,
    StudentsModule,
    AiModule,
    AuditModule,
    ConsentModule,
    SupportFlagsModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
