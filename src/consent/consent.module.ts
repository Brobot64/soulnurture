import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { ConsentController } from './consent.controller.js';
import { ConsentService } from './consent.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
