import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import type { SendMailOptions as NodemailerSendMailOptions, Transporter } from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import type { EmailOptions } from './interfaces/mail-config.interface.js';

export interface SendMailOptions extends Omit<NodemailerSendMailOptions, 'html'> {
    template: string;
    context: Record<string, any>;
}

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);

    constructor(
        @Inject('NODEMAILER_TRANSPORTER')
        private readonly transporter: Transporter,
        @Inject('EMAIL_MODULE_OPTIONS')
        private readonly options: EmailOptions,
    ) {}

    async sendMail(options: SendMailOptions): Promise<any> {
        try {
            const templatePath = path.join(this.options.templateDir, `${options.template}.hbs`);

            if(!fs.existsSync(templatePath)) {
                throw new InternalServerErrorException(`Template ${options.template} not found`);
            }

            const templateSource = fs.readFileSync(templatePath, 'utf8');
            const compiledTemplate = Handlebars.compile(templateSource);
            const html = compiledTemplate(options.context);

            const { template: _template, context: _context, ...cleanNodemailerOptions } = options;

            const info = await this.transporter.sendMail({
                ...cleanNodemailerOptions,
                html,
            });

            this.logger.log(`Email sent successfully: ${info.messageId}`);
            const previewUrl = nodemailer.getTestMessageUrl(info);
            if (previewUrl) {
                this.logger.log(`Email preview: ${previewUrl}`);
            }
            return info;
        } catch (error) {
            const detail = error instanceof Error ? error.stack ?? error.message : String(error);
            const toStr = Array.isArray(options.to)
              ? options.to.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(', ')
              : JSON.stringify(options.to);
            this.logger.error(`Error sending email to ${toStr}: ${detail}`);
            throw new InternalServerErrorException('Failed to send email');
        }
    }
}
