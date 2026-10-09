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

/**
 * better-auth builds the verify link as `{baseURL}/verify-email?token=…&callbackURL=…`
 * and, after consuming the token, redirects to that callbackURL (default "/" —
 * the API root). Point it at the web app so clicking the emailed link lands the
 * freshly signed-in user in the app instead of on the API.
 */
function withWebAppCallback(url: string, webAppUrl: string): string {
    const target = new URL(url);
    target.searchParams.set('callbackURL', `${webAppUrl}/welcome`);
    return target.toString();
}

export function createAuth(
    prisma: PrismaService,
    mailer: MailerService
) {
    // Cross-site frontends (e.g. Vercel) get SameSite=None + Secure cookies —
    // without them the browser never returns the session cookie cross-origin.
    const crossSiteCookies = process.env.BETTER_AUTH_CROSS_SITE_COOKIES === 'true';

    // better-auth merges BETTER_AUTH_TRUSTED_ORIGINS natively for its own
    // origin checks, but the @thallesp/nestjs-better-auth Fastify preflight
    // interceptor reads ONLY this array — without merging the env var in,
    // CORS preflights on /api/auth/* fall through to better-auth's router
    // and 404, so cross-origin sign-up/sign-in never leaves the browser.
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    // Where the verify link drops the user after the API consumes the token.
    // Falls back to the first concrete trusted origin (the deployed frontend
    // in production); a wildcard entry can never be a redirect target.
    const webAppUrl = (
        process.env.WEB_APP_URL ??
        envTrustedOrigins.find((origin) => !origin.includes('*')) ??
        ''
    ).replace(/\/+$/, '');

    /// Blocks sign-in for users whose school is suspended or whose account is
    /// deactivated. The 403 message doubles as the "notification at sign-in".
    /// The request-time TenantGuard (src/common/guards/tenant.guard.ts) cuts
    /// off already-issued sessions the same way.
    const schoolStatusGuard = {
        id: 'school-status-guard',
        hooks: {
            before: [{
                matcher: (context) => context.path === '/sign-in/email',
                handler: createAuthMiddleware(async (context) => {
                    const email = (context.body as { email?: unknown }).email;
                    if (typeof email !== 'string') return;

                    const user = await prisma.user.findFirst({
                        where: {
                            email: {
                                equals: email.trim(),
                                mode: 'insensitive',
                            },
                        },
                        select: {
                            deactivatedAt: true,
                            school: { select: { status: true } },
                        },
                    });
                    if (!user) return;

                    if (user.deactivatedAt) {
                        throw APIError.from('FORBIDDEN', {
                            code: 'ACCOUNT_DEACTIVATED',
                            message:
                                'This account has been deactivated. Contact your school administrator.',
                        });
                    }
                    if (user.school?.status === 'SUSPENDED') {
                        throw APIError.from('FORBIDDEN', {
                            code: 'SCHOOL_SUSPENDED',
                            message:
                                'Your school is currently suspended. Contact your school administrator.',
                        });
                    }
                }),
            }],
        },
    } satisfies BetterAuthPlugin;

    return betterAuth({
        database: prismaAdapter(prisma, { provider: 'postgresql' }),
        basePath: '/api/auth',
        plugins: [schoolStatusGuard],
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
                // Surfaces in the session right after verification so the web
                // app can force the first-password screen. Flows from the DB
                // on every getSession — no stale copies.
                mustChangePassword: {
                    type: 'boolean',
                    required: false,
                    input: false,
                    defaultValue: false,
                },
            },
        },

        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            // Accounts enter only by provisioning (school onboarding, staff
            // bootstrap, platform-admin grant). A uniform 400 with
            // EMAIL_PASSWORD_SIGN_UP_DISABLED replaces the old duplicate-email
            // 422 so sign-up can no longer probe which emails exist.
            disableSignUp: true,

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
                const verificationUrl = webAppUrl ? withWebAppCallback(url, webAppUrl) : url;
                if (process.env.NODE_ENV !== 'production') {
                    // Dev/test aid: the journey reads links via the dev-links
                    // endpoint; production never records them.
                    DevVerificationLinks.set(user.email, verificationUrl);
                }
                // School onboarding carries the school's name into the email —
                // "added to Soul Nurture AI from <School>".
                const dbUser = await prisma.user.findUnique({
                    where: { email: user.email },
                    select: { school: { select: { name: true } } },
                });
                const schoolName = dbUser?.school?.name ?? null;
                await mailer.sendMail({
                    to: user.email,
                    subject: schoolName
                        ? `Verify your email — Soul Nurture AI (${schoolName})`
                        : 'Verify your Nurture AI Email',
                    template: 'verify-email',
                    context: {
                        name: user.name,
                        verificationUrl,
                        schoolName,
                    },
                });
            },
        },

        session: {
            expiresIn: 60 * 60 * 24 * 7, // 7 days
            updateAge: 60 * 60 * 24, // 1 day
        },

        trustedOrigins: [
            'http://localhost:3001',
            'http://localhost:3000',
            ...envTrustedOrigins,
        ],
    })
}