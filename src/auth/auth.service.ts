import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService as BetterAuthService } from "@thallesp/nestjs-better-auth";


@Injectable()
export class AuthService {
    constructor(
        private readonly betterAuth: BetterAuthService,
    ) {}

    async getSession(headers: Headers) {
        const session = await this.betterAuth.api.getSession({
            headers,
        });
        
        if (!session) {
            throw new UnauthorizedException(
                'Authentication required'
            );
        }
        return session;
    }

    async resendVerificationEmail(email: string) {
        return this.betterAuth.api.sendVerificationEmail({
            body: { email },
        });
    }
}