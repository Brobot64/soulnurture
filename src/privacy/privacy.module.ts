import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { PrivacyController } from './privacy.controller.js';
import { PrivacyService } from './privacy.service.js';

@Module({
  imports: [PrismaModule, StudentsModule, AuditModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
