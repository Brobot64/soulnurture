import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsController } from './students.controller.js';
import { StudentsService } from './students.service.js';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
