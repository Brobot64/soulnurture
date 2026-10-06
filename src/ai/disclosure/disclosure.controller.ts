import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../../docs/openapi.helpers.js';
import { Roles } from '../../common/guards/roles.decorator.js';
import { ConsentService } from '../../consent/consent.service.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  aiDisclosureView,
  AI_DISCLOSURE_CONSENT_VERSION,
} from './ai-disclosure.js';

@ApiTags('AI disclosure (capabilities & limits)')
@Controller('v1/ai/disclosure')
export class AiDisclosureController {
  constructor(
    private readonly consentService: ConsentService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @AllowAnonymous()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'AI capabilities and limits explanation (pre-login readable)',
  })
  @ApiEnvelopeOk(Object)
  view() {
    return aiDisclosureView();
  }

  @Post('acknowledge')
  @Roles('STUDENT')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Record that the student has seen the AI explanation',
  })
  @ApiEnvelopeOk(Object)
  async acknowledge(@Session() session: UserSession) {
    const record = await this.consentService.accept(
      session.user.id,
      AI_DISCLOSURE_CONSENT_VERSION,
    );
    await this.auditService.log({
      actorId: session.user.id,
      action: 'ai.disclosure_acknowledged',
      entity: 'ConsentRecord',
      entityId: record.id,
      meta: { version: AI_DISCLOSURE_CONSENT_VERSION },
    });
    return { acknowledged: true, record };
  }
}
