import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { SchoolsAdminController } from './schools-admin.controller.js';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AdminController, SchoolsAdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
