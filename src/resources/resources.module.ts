import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [ResourcesController],
  providers: [ResourcesService],
  exports: [ResourcesService],
})
export class ResourcesModule {}
