import { Test, TestingModule } from '@nestjs/testing';
import { fileURLToPath } from 'node:url';
import { MailerService } from './mailer.service.js';
import { EMAIL_MODULE_OPTIONS, NODEMAILER_TRANSPORTER } from './mail.constants.js';

describe('MailerService', () => {
  let service: MailerService;
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'test-message' });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailerService,
        { provide: NODEMAILER_TRANSPORTER, useValue: { sendMail } },
        {
          provide: EMAIL_MODULE_OPTIONS,
          useValue: {
            transport: {},
            defaults: { from: 'test@example.com' },
            templateDir: fileURLToPath(new URL('./templates/', import.meta.url)),
          },
        },
      ],
    }).compile();

    service = module.get<MailerService>(MailerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('renders the template and sends the compiled HTML', async () => {
    await service.sendMail({
      to: 'test@example.com',
      subject: 'Verify your email',
      template: 'verify-email',
      context: {
        name: 'Test User',
        verificationUrl: 'https://example.com/verify',
      },
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        html: expect.stringContaining('Hello Test User'),
      }),
    );
  });
});
