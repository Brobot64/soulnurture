import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { fileURLToPath } from 'node:url';
import { ActivitiesModule } from './activities/activities.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AiModule } from './ai/ai.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from './common/guards/roles.guard.js';
import { TenantGuard } from './common/guards/tenant.guard.js';
import { CheckInsModule } from './check-ins/check-ins.module.js';
import { ConsentModule } from './consent/consent.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { validateEnv } from './config/env.config.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DocsModule } from './docs/docs.module.js';
import { FollowUpsModule } from './follow-ups/follow-ups.module.js';
import { JournalModule } from './journal/journal.module.js';
import { MailerModule } from './mailer/mailer.module.js';
import type { EmailOptions } from './mailer/interfaces/mail-config.interface.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrivacyModule } from './privacy/privacy.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProfessionalsModule } from './professionals/professionals.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { ResourcesModule } from './resources/resources.module.js';
import { SchoolsModule } from './schools/schools.module.js';
import { StorageModule } from './storage/storage.module.js';
import { StudentsModule } from './students/students.module.js';
import { SupportFlagsModule } from './support-flags/support-flags.module.js';
import { SupportRequestsModule } from './support-requests/support-requests.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      expandVariables: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AdminModule,
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailOptions => {
        const port = config.getOrThrow<number>('SMTP_PORT');
        return {
          transport: {
            host: config.getOrThrow<string>('SMTP_HOST'),
            port,
            secure: port === 465,
            auth: {
              user: config.getOrThrow<string>('SMTP_USER'),
              pass: config.getOrThrow<string>('SMTP_PASS'),
            },
          },
          defaults: {
            from: config.getOrThrow<string>('MAIL_FROM'),
          },
          templateDir: fileURLToPath(
            new URL('./mailer/templates/', import.meta.url),
          ),
        };
      },
    }),
    AuthModule,
    DocsModule,
    UsersModule,
    StudentsModule,
    ProfessionalsModule,
    SchoolsModule,
    ConsentModule,
    CheckInsModule,
    ConversationsModule,
    AiModule,
    ResourcesModule,
    ActivitiesModule,
    SupportRequestsModule,
    SupportFlagsModule,
    NotificationsModule,
    RealtimeModule,
    FollowUpsModule,
    DashboardModule,
    AuditModule,
    JournalModule,
    PrivacyModule,
    StorageModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered after the Better Auth auth guard (see auth.module) so session
    // is populated before role checks run. The library also registers a global
    // guard via APP_GUARD; order in this list determines execution order.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // After RolesGuard: enforces school suspension / deactivation /
    // must-change-password on every /api/v1 route (403 with coded errors).
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
  ],
})
export class AppModule {}
