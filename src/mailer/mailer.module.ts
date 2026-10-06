import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MailerService } from './mailer.service.js';
import type { EmailOptions } from './interfaces/mail-config.interface.js';
import { EMAIL_MODULE_OPTIONS } from './mail.constants.js';
import nodemailer from 'nodemailer';

@Global()
@Module({})
export class MailerModule {
  static forRootAsync(options: {
    useFactory: (...args: any[]) => Promise<EmailOptions> | EmailOptions;
    inject?: any[];
    imports?: any[];
  }): DynamicModule {
    const optionsProvider: Provider = {
      provide: EMAIL_MODULE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    const transporterProvider: Provider = {
      provide: 'NODEMAILER_TRANSPORTER',
      useFactory: (config: EmailOptions) => {
        return nodemailer.createTransport(config.transport, config.defaults);
      },
      inject: [EMAIL_MODULE_OPTIONS],
    };

    return {
      module: MailerModule,
      imports: options.imports ?? [],
      providers: [optionsProvider, transporterProvider, MailerService],
      exports: [MailerService],
    };
  }
}
