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
