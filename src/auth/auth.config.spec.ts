import { createAuth } from './auth.config.js';

const prismaStub = { user: { findFirst: async () => null } } as never;
const mailerStub = { sendMail: async () => undefined } as never;

describe('createAuth trustedOrigins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('merges BETTER_AUTH_TRUSTED_ORIGINS into the options array (trimmed)', () => {
    vi.stubEnv(
      'BETTER_AUTH_TRUSTED_ORIGINS',
      'https://soulnurture.vercel.app, https://app.example.com',
    );

    const auth = createAuth(prismaStub, mailerStub);

    expect(auth.options.trustedOrigins).toContain('http://localhost:3000');
    expect(auth.options.trustedOrigins).toContain('http://localhost:3001');
    expect(auth.options.trustedOrigins).toContain('https://soulnurture.vercel.app');
    expect(auth.options.trustedOrigins).toContain('https://app.example.com');
  });

  it('keeps only the localhost defaults when the env var is unset', () => {
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');

    const auth = createAuth(prismaStub, mailerStub);

    expect(auth.options.trustedOrigins).toEqual([
      'http://localhost:3001',
      'http://localhost:3000',
    ]);
  });
});

describe('createAuth verification link redirect', () => {
  const userStub = { email: 'sam@example.com', name: 'Sam' } as never;
  const rawUrl =
    'https://api.example.com/api/auth/verify-email?token=abc&callbackURL=/';

  function captureMailer() {
    const sent: Array<{ context: { verificationUrl: string } }> = [];
    const mailer = {
      sendMail: async (mail: { context: { verificationUrl: string } }) => {
        sent.push(mail);
      },
    } as never;
    return { sent, mailer };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects to /welcome on the first concrete trusted origin by default', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'BETTER_AUTH_TRUSTED_ORIGINS',
      'https://soulnurture.vercel.app, https://*.vercel.app',
    );
    const captured = captureMailer();
    const auth = createAuth(prismaStub, captured.mailer);

    await auth.options.emailVerification!.sendVerificationEmail(
      { user: userStub, url: rawUrl, token: 'abc' } as never,
      {} as never,
    );

    const link = new URL(captured.sent[0].context.verificationUrl);
    expect(link.searchParams.get('callbackURL')).toBe(
      'https://soulnurture.vercel.app/welcome',
    );
    expect(link.searchParams.get('token')).toBe('abc');
  });

  it('honours WEB_APP_URL over the trusted origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', 'https://soulnurture.vercel.app');
    vi.stubEnv('WEB_APP_URL', 'https://app.example.com/');
    const captured = captureMailer();
    const auth = createAuth(prismaStub, captured.mailer);

    await auth.options.emailVerification!.sendVerificationEmail(
      { user: userStub, url: rawUrl, token: 'abc' } as never,
      {} as never,
    );

    const link = new URL(captured.sent[0].context.verificationUrl);
    expect(link.searchParams.get('callbackURL')).toBe(
      'https://app.example.com/welcome',
    );
  });

  it('leaves the link untouched when no web app origin is known', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');
    const captured = captureMailer();
    const auth = createAuth(prismaStub, captured.mailer);

    await auth.options.emailVerification!.sendVerificationEmail(
      { user: userStub, url: rawUrl, token: 'abc' } as never,
      {} as never,
    );

    expect(captured.sent[0].context.verificationUrl).toBe(rawUrl);
  });
});
