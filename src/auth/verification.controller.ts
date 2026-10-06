import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { ApiEnvelopeOk, ApiStandardErrors } from '../docs/openapi.helpers.js';
import { AuthService } from './auth.service.js';
import {
  ResendVerificationDto,
  ResendVerificationResultDto,
} from './dto/auth.dto.js';
import { DevVerificationLinks } from './auth.config.js';

@ApiTags('Verification (live)')
@Controller('verification')
export class VerificationController {
  constructor(private readonly authService: AuthService) {}

  @Post('resend')
  @HttpCode(HttpStatus.OK)
  @AllowAnonymous()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Resend email verification',
    description: `
**Live.** Triggers Better Auth verification email resend for the given address.

Safe to call when the user has not verified yet. Response is enveloped by Nest.
`,
  })
  @ApiBody({ type: ResendVerificationDto })
  @ApiEnvelopeOk(ResendVerificationResultDto)
  async resend(@Body() body: ResendVerificationDto) {
    return this.authService.resendVerificationEmail(body.email);
  }

  /**
   * Development/test aid (see DevVerificationLinks): returns the verification
   * link for an email whose verification mail was dispatched in this process.
   * Always 404s outside development — it is not a production surface.
   */
  @Get('dev-links/:email')
  @AllowAnonymous()
  @ApiStandardErrors()
  @ApiOperation({
    summary: '(dev only) fetch the last verification link for an email',
  })
  devLink(@Param('email') email: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const url = DevVerificationLinks.get(email.toLowerCase());
    if (!url) throw new NotFoundException('No verification link recorded');
    return { url };
  }
}
