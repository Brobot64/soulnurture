import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConsentModule } from '../consent/consent.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SupportFlagsModule } from '../support-flags/support-flags.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';
import { AiResponseReportsController } from './ai-response-reports.controller.js';
import { AiResponseReportsService } from './ai-response-reports.service.js';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    AuditModule,
    ConsentModule,
    SupportFlagsModule,
    RealtimeModule,
  ],
  controllers: [ConversationsController, AiResponseReportsController],
  providers: [ConversationsService, AiResponseReportsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
