import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [JournalController],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
