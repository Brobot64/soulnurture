import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { AcceptConsentDto } from './dto/accept-consent.dto.js';
import { ConsentService } from './consent.service.js';

@ApiTags('Consent & Privacy (contract)')
@Controller('v1/consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Get('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List consent records' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.consentService.listMine(session.user.id);
  }

  @Post('accept')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Accept consent version' })
  @ApiBody({ type: AcceptConsentDto })
  @ApiEnvelopeOk(Object)
  accept(@Session() session: UserSession, @Body() body: AcceptConsentDto) {
    return this.consentService.accept(session.user.id, body.version);
  }
}
