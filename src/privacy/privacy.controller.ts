import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { UpdatePrivacyDto } from './dto/update-privacy.dto.js';
import { PrivacyService } from './privacy.service.js';

@ApiTags('Consent & Privacy (contract)')
@Controller('v1/privacy')
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  @Get('preferences')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get privacy preferences' })
  @ApiEnvelopeOk(Object)
  get(@Session() session: UserSession) {
    return this.privacyService.get(session.user.id);
  }

  @Patch('preferences')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Update privacy preferences' })
  @ApiBody({ type: UpdatePrivacyDto })
  @ApiEnvelopeOk(Object)
  update(@Session() session: UserSession, @Body() body: UpdatePrivacyDto) {
    return this.privacyService.update(session.user.id, body);
  }
}
