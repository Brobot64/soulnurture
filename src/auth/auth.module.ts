import { Module } from '@nestjs/common';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MailerModule } from '../mailer/mailer.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailerService } from '../mailer/mailer.service.js';
import { createAuth } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { VerificationController } from './verification.controller.js';

@Module({
    imports: [
        PrismaModule,
        MailerModule,
        BetterAuthModule.forRootAsync({
            imports: [PrismaModule, MailerModule],
            inject: [PrismaService, MailerService],
            useFactory: (prisma: PrismaService, mailer: MailerService) => ({
                auth: createAuth(prisma, mailer),
            }),
        }),
    ],
    controllers: [AuthController, VerificationController],
    providers: [AuthService],
    exports: [AuthService],
})
export class AuthModule {}