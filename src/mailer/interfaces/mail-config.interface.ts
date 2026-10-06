import * as Transport from 'nodemailer/lib/smtp-transport';

export interface EmailOptions {
  transport: Transport.Options;
  defaults: {
    from: string;
  };
  templateDir: string;
}