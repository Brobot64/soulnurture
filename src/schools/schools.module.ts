import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SchoolUsersController } from './school-users.controller.js';
import { SchoolUsersService } from './school-users.service.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  controllers: [SchoolUsersController],
  providers: [SchoolUsersService],
  exports: [SchoolUsersService],
})
export class SchoolsModule {}
