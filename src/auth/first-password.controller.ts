import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { FirstPasswordDto } from './dto/first-password.dto.js';
import { FirstPasswordService } from './first-password.service.js';

@ApiTags('Auth (live)')
@Controller('v1/auth')
export class FirstPasswordController {
  constructor(private readonly firstPasswordService: FirstPasswordService) {}

  @Post('first-password')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Set your own password after school onboarding',
    description: `
**Live.** Replaces the school default credential. Only callable while the
session user is flagged \`mustChangePassword\` (i.e. straight after email
verification). No old password is requested — the account currently holds the
school's default. All other sessions are revoked.
`,
  })
  @ApiBody({ type: FirstPasswordDto })
  @ApiEnvelopeOk(Object)
  setFirstPassword(
    @Session() session: UserSession,
    @Body() body: FirstPasswordDto,
  ) {
    return this.firstPasswordService.setFirstPassword(
      session.user.id,
      session.session?.token,
      body.newPassword,
    );
  }
}
