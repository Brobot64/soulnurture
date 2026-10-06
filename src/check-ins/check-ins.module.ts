import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { CheckInsController } from './check-ins.controller.js';
import { CheckInsService } from './check-ins.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [CheckInsController],
  providers: [CheckInsService],
  exports: [CheckInsService],
})
export class CheckInsModule {}
