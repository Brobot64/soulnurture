import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SupportFlagAlertsService } from './support-flag-alerts.service.js';
import { SupportFlagsController } from './support-flags.controller.js';
import { SupportFlagsService } from './support-flags.service.js';

@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule],
  controllers: [SupportFlagsController],
  providers: [SupportFlagsService, SupportFlagAlertsService],
  exports: [SupportFlagsService, SupportFlagAlertsService],
})
export class SupportFlagsModule {}
