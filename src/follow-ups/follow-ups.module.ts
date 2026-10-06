import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProfessionalsModule } from '../professionals/professionals.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FollowUpsController } from './follow-ups.controller.js';
import { FollowUpsService } from './follow-ups.service.js';

@Module({
  imports: [PrismaModule, AuditModule, ProfessionalsModule],
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
  exports: [FollowUpsService],
})
export class FollowUpsModule {}
