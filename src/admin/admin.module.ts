import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { SchoolsAdminController } from './schools-admin.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule, RealtimeModule],
  controllers: [AdminController, SchoolsAdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
