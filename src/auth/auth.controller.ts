import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllowAnonymous,
  Session,
} from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  AuthHealthDataDto,
  UserDto,
  UserSessionDto,
} from '../common/dto/api-response.dto.js';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';

@ApiTags('Users & Session (live)')
@Controller()
export class AuthController {
  @Get('users/me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Get current authenticated user',
    description: `
**Live.** Returns the Better Auth user for the active session cookie.

Use this after sign-in for Sanctuary profile header (name, image, emailVerified).
Application identity for all domain resources is \`user.id\`.
`,
  })
  @ApiEnvelopeOk(UserDto)
  async me(@Session() session: UserSession) {
    return session.user;
  }

  @Get('users/session')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Get full session payload',
    description: '**Live.** Returns `{ user, session }` for the current cookie session.',
  })
  @ApiEnvelopeOk(UserSessionDto)
  async session(@Session() session: UserSession) {
    return session;
  }

  @Get('health/auth')
  @AllowAnonymous()
  @ApiTags('Health (live)')
  @ApiOperation({
    summary: 'Auth service health',
    description: '**Live.** Anonymous liveness probe for the auth surface.',
  })
  @ApiEnvelopeOk(AuthHealthDataDto)
  async health() {
    return {
      authenticated: true,
      service: 'auth',
    };
  }
}
