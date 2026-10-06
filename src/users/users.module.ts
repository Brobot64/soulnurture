import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StaffBootstrapController } from './staff-bootstrap.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule],
  controllers: [UsersController, StaffBootstrapController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
