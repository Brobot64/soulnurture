import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SupportFlagsController } from './support-flags.controller.js';
import { SupportFlagsService } from './support-flags.service.js';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [SupportFlagsController],
  providers: [SupportFlagsService],
  exports: [SupportFlagsService],
})
export class SupportFlagsModule {}
