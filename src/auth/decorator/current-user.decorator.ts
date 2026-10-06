import { 
    createParamDecorator,
    ExecutionContext,
} from '@nestjs/common';

import type { UserSession } from '@thallesp/nestjs-better-auth';

export const CurrentUser = createParamDecorator(
    (
        _data: unknown,
        ctx: ExecutionContext,
    ) => {
        const request = ctx.switchToHttp().getRequest();

        const session = request.session as UserSession | undefined;

        return session?.user;
    }
)