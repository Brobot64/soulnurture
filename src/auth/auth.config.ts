import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaService } from '../prisma/prisma.service.js';
import { MailerService } from '../mailer/mailer.service.js';


/**
 * Dev/test-only store of verification links keyed by email. The
 * GET /api/verification/dev-links/:email endpoint serves it exclusively when
 * NODE_ENV=development, so E2E runs can verify accounts without an inbox.
 * In production the map stays empty AND the endpoint refuses to run.
 */
export const DevVerificationLinks = new Map<string, string>();

export function createAuth(
    prisma: PrismaService,
    mailer: MailerService
) {
    // Cross-site frontends (e.g. Vercel) get SameSite=None + Secure cookies —
    // without them the browser never returns the session cookie cross-origin.
    const crossSiteCookies = process.env.BETTER_AUTH_CROSS_SITE_COOKIES === 'true';

    const rejectExistingEmailSignup = {
        id: 'reject-existing-email-signup',
        hooks: {
            before: [{
                matcher: (context) => context.path === '/sign-up/email',
                handler: createAuthMiddleware(async (context) => {
                    const email = (context.body as { email?: unknown }).email;
                    if (typeof email !== 'string') return;

                    const existingUser = await prisma.user.findFirst({
                        where: {
                            email: {
                                equals: email.trim(),
                                mode: 'insensitive',
                            },
                        },
                        select: { id: true },
                    });

                    if (existingUser) {
                        throw APIError.from('UNPROCESSABLE_ENTITY', {
                            code: 'USER_ALREADY_EXISTS',
                            message: 'An account with this email already exists.',
                        });
                    }
                }),
            }],
        },
    } satisfies BetterAuthPlugin;

    return betterAuth({
        database: prismaAdapter(prisma, { provider: 'postgresql' }),
        basePath: '/api/auth',
        plugins: [rejectExistingEmailSignup],
        advanced: {
            database: {
                generateId: 'uuid',
            },
            ...(crossSiteCookies
                ? { defaultCookieAttributes: { sameSite: 'none', secure: true } }
                : {}),
        },
        user: {
            additionalFields: {
                phone: {
                    type: 'string',
                    required: false,
                    input: true,
                },
                role: {
                    type: 'string',
                    required: false,
                    input: false,
                },
            },
        },

        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,

            sendResetPassword: async ({ user, url }) => {
                await mailer.sendMail({
                    to: user.email,
                    subject: "Reset your Nurture AI Password",
                    template: 'reset-password',
                    context: {
                        name: user.name,
                        resetUrl: url
                    },
                });
            },
        },

        emailVerification: {
            sendOnSignUp: true,

            autoSignInAfterVerification: true,

            sendVerificationEmail: async ({ user, url }) => {
                if (process.env.NODE_ENV !== 'production') {
                    // Dev/test aid: the journey reads links via the dev-links
                    // endpoint; production never records them.
                    DevVerificationLinks.set(user.email, url);
                }
                await mailer.sendMail({
                    to: user.email,
                    subject: "Verify your Nurture AI Email",
                    template: 'verify-email',
                    context: {
                        name: user.name,
                        verificationUrl: url
                    },
                });
            },
        },

        session: {
            expiresIn: 60 * 60 * 24 * 7, // 7 days
            updateAge: 60 * 60 * 24, // 1 day
        },

        // better-auth also appends BETTER_AUTH_TRUSTED_ORIGINS (comma-separated)
        // natively; the deployed frontend origin belongs there.
        trustedOrigins: [
            'http://localhost:3001',
            'http://localhost:3000',
        ],
    })
}