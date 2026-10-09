import { createAuth } from './auth.config.js';

const prismaStub = {
  user: { findFirst: async () => null, findUnique: async () => null },
} as never;
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

describe('createAuth sign-up lock', () => {
  it('disables public email/password sign-up — accounts enter only by provisioning', () => {
    const auth = createAuth(prismaStub, mailerStub);

    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
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

  it('names the school in the subject and context when the user belongs to one', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', 'https://soulnurture.vercel.app');
    const sent: Array<{
      subject: string;
      context: { schoolName?: string | null };
    }> = [];
    const mailer = {
      sendMail: async (mail: (typeof sent)[number]) => {
        sent.push(mail);
      },
    } as never;
    const prisma = {
      user: {
        findFirst: async () => null,
        findUnique: async () => ({ school: { name: 'Achimota School' } }),
      },
    } as never;
    const auth = createAuth(prisma, mailer);

    await auth.options.emailVerification!.sendVerificationEmail(
      { user: userStub, url: rawUrl, token: 'abc' } as never,
      {} as never,
    );

    expect(sent[0].subject).toContain('Achimota School');
    expect(sent[0].context.schoolName).toBe('Achimota School');
  });
});

describe('createAuth school-status sign-in guard', () => {
  type BeforeHook = {
    matcher: (context: { path: string }) => boolean;
    handler: (context: {
      path: string;
      body: Record<string, unknown>;
    }) => Promise<unknown>;
  };

  function schoolStatusHook(prismaLookup: () => unknown): BeforeHook {
    const prisma = {
      user: {
        findFirst: async () => prismaLookup(),
        findUnique: async () => null,
      },
    } as never;
    const auth = createAuth(prisma, mailerStub);
    const plugins = auth.options.plugins as unknown as Array<{
      id: string;
      hooks?: { before?: BeforeHook[] };
    }>;
    const hook = plugins
      .find((entry) => entry.id === 'school-status-guard')
      ?.hooks?.before?.[0];
    if (!hook) throw new Error('school-status-guard before-hook missing');
    return hook;
  }

  const signInContext = {
    path: '/sign-in/email',
    body: { email: 'Sam@Example.com' },
  };

  it('matches only the email sign-in path', () => {
    const hook = schoolStatusHook(() => null);
    expect(hook.matcher(signInContext)).toBe(true);
    expect(hook.matcher({ path: '/sign-up/email' })).toBe(false);
    expect(hook.matcher({ path: '/sign-in/social' })).toBe(false);
  });

  it('blocks deactivated accounts with ACCOUNT_DEACTIVATED', async () => {
    const hook = schoolStatusHook(() => ({
      deactivatedAt: new Date(),
      school: null,
    }));

    await expect(hook.handler(signInContext)).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'ACCOUNT_DEACTIVATED' },
    });
  });

  it('blocks users of suspended schools with SCHOOL_SUSPENDED', async () => {
    const hook = schoolStatusHook(() => ({
      deactivatedAt: null,
      school: { status: 'SUSPENDED' },
    }));

    await expect(hook.handler(signInContext)).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'SCHOOL_SUSPENDED' },
    });
  });

  it('lets active users through untouched', async () => {
    const hook = schoolStatusHook(() => ({
      deactivatedAt: null,
      school: { status: 'ACTIVE' },
    }));

    await hook.handler(signInContext);
  });

  it('lets unknown emails fall through to the normal auth flow', async () => {
    const hook = schoolStatusHook(() => null);

    await hook.handler(signInContext);
  });

  it('ignores requests without an email body', async () => {
    let lookedUp = false;
    const hook = schoolStatusHook(() => {
      lookedUp = true;
      return null;
    });

    await hook.handler({ path: '/sign-in/email', body: {} });

    expect(lookedUp).toBe(false);
  });
});
