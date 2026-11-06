import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { HistoryModule } from '../history/history.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { UserErasureService } from './user-erasure.service.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    RealtimeModule,
    HistoryModule,
  ],
  providers: [UserErasureService],
  exports: [UserErasureService],
})
export class UserErasureModule {}
