import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Better Auth owns `/api/auth/*`. We document those paths in OpenAPI without
 * registering Nest controllers on the same prefix (which would conflict).
 */
export function attachBetterAuthOpenApi(document: OpenAPIObject): OpenAPIObject {
  const tag = 'Better Auth (live)';
  if (!document.tags?.some((t) => t.name === tag)) {
    document.tags = [...(document.tags ?? []), { name: tag, description: 'Live Better Auth routes — call directly, not via Nest proxies.' }];
  }

  document.components = document.components ?? {};
  document.components.schemas = {
    ...document.components.schemas,
    BetterAuthSignUpDto: {
      type: 'object',
      required: ['name', 'email', 'password'],
      properties: {
        name: { type: 'string', example: 'Amina Okonkwo' },
        email: { type: 'string', format: 'email', example: 'amina@school.edu' },
        password: { type: 'string', minLength: 8, example: 'Str0ng-P@ssw0rd' },
        phone: { type: 'string', example: '+2348012345678' },
        callbackURL: { type: 'string', example: 'http://localhost:3001/verify-success' },
      },
    },
    BetterAuthSignInDto: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: { type: 'string', format: 'email', example: 'amina@school.edu' },
        password: { type: 'string', example: 'Str0ng-P@ssw0rd' },
        rememberMe: { type: 'boolean', example: false },
        callbackURL: { type: 'string', example: 'http://localhost:3001/sanctuary' },
      },
    },
    BetterAuthForgetPasswordDto: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email' },
        redirectTo: { type: 'string', example: 'http://localhost:3001/reset-password' },
      },
    },
    BetterAuthResetPasswordDto: {
      type: 'object',
      required: ['token', 'newPassword'],
      properties: {
        token: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
    BetterAuthSessionResponseDto: {
      type: 'object',
      properties: {
        session: {
          nullable: true,
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            token: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        user: {
          nullable: true,
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            emailVerified: { type: 'boolean' },
            image: { type: 'string', nullable: true },
            phone: { type: 'string', nullable: true },
          },
        },
      },
    },
  };

  const json = (schema: string) => ({
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  });

  const betterAuthNote =
    'Owned by Better Auth. Response is **not** wrapped in the Nest `{ success, data }` envelope. Session cookies are set via `Set-Cookie`. Use `credentials: "include"` from the browser.';

  document.paths = {
    ...document.paths,
    '/api/auth/sign-up/email': {
      post: {
        tags: [tag],
        summary: 'Sign up with email/password (disabled)',
        description: `${betterAuthNote}\n\nPublic sign-up is **disabled**: accounts enter only by provisioning (school onboarding, staff bootstrap, platform-admin routes). Always answers **400** \`EMAIL_PASSWORD_SIGN_UP_DISABLED\` — a uniform error so sign-up cannot probe whether an email exists.`,
        requestBody: json('BetterAuthSignUpDto'),
        responses: {
          '400': { description: 'Public sign-up disabled (EMAIL_PASSWORD_SIGN_UP_DISABLED)' },
        },
      },
    },
    '/api/auth/sign-in/email': {
      post: {
        tags: [tag],
        summary: 'Sign in with email/password',
        description: betterAuthNote,
        requestBody: json('BetterAuthSignInDto'),
        responses: {
          '200': { description: 'Signed in; session cookie set' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/api/auth/sign-out': {
      post: {
        tags: [tag],
        summary: 'Sign out',
        description: betterAuthNote,
        responses: {
          '200': { description: 'Session cleared' },
        },
      },
    },
    '/api/auth/get-session': {
      get: {
        tags: [tag],
        summary: 'Get current session',
        description: `${betterAuthNote}\n\nPrefer Nest \`GET /api/users/me\` for enveloped user payload after login.`,
        responses: {
          '200': {
            description: 'Session payload or null user/session',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BetterAuthSessionResponseDto' },
              },
            },
          },
        },
      },
    },
    '/api/auth/forget-password': {
      post: {
        tags: [tag],
        summary: 'Request password reset email',
        description: betterAuthNote,
        requestBody: json('BetterAuthForgetPasswordDto'),
        responses: {
          '200': { description: 'Reset email dispatched when account exists' },
        },
      },
    },
    '/api/auth/reset-password': {
      post: {
        tags: [tag],
        summary: 'Complete password reset',
        description: betterAuthNote,
        requestBody: json('BetterAuthResetPasswordDto'),
        responses: {
          '200': { description: 'Password updated' },
        },
      },
    },
    '/api/auth/verify-email': {
      get: {
        tags: [tag],
        summary: 'Verify email from link',
        description: `${betterAuthNote}\n\nQuery param \`token\` from verification email. May auto sign-in after verification.`,
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Email verified' },
        },
      },
    },
  };

  return document;
}
