import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { Prisma } from '@prisma/client';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../../docs/openapi.helpers.js';
import { Roles } from '../../common/guards/roles.decorator.js';
import { ConsentService } from '../../consent/consent.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AcknowledgeDisclosureDto } from './dto/acknowledge-disclosure.dto.js';
import {
  aiDisclosureView,
  AI_DISCLOSURE_AGREEMENT_IDS,
  AI_DISCLOSURE_CONSENT_VERSION,
  AI_DISCLOSURE_VERSION,
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

  @Get('status')
  @Roles('STUDENT')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary:
      'Has the signed-in student accepted the current AI explanation? (drives the pre-chat consent gate)',
  })
  @ApiEnvelopeOk(Object)
  status(@Session() session: UserSession) {
    return this.consentService.status(
      session.user.id,
      AI_DISCLOSURE_CONSENT_VERSION,
    );
  }

  @Post('acknowledge')
  @Roles('STUDENT')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Record that the student has seen and accepted the AI explanation',
  })
  @ApiBody({ type: AcknowledgeDisclosureDto })
  @ApiEnvelopeOk(Object)
  async acknowledge(
    @Session() session: UserSession,
    @Body() body: AcknowledgeDisclosureDto,
  ) {
    const ticked = new Set(body.agreements);
    const missing = AI_DISCLOSURE_AGREEMENT_IDS.filter((id) => !ticked.has(id));
    const unknown = body.agreements.filter(
      (id) => !AI_DISCLOSURE_AGREEMENT_IDS.includes(id),
    );
    if (missing.length > 0 || unknown.length > 0) {
      throw new BadRequestException(
        missing.length > 0
          ? 'Every statement must be accepted before you can chat.'
          : 'Unknown agreement in request.',
      );
    }

    // Stored server-side (never from the client's order) so the audit trail
    // records the exact statements that existed in this disclosure version.
    const metadata = {
      disclosureVersion: AI_DISCLOSURE_VERSION,
      agreements: AI_DISCLOSURE_AGREEMENT_IDS,
    } as unknown as Prisma.InputJsonValue;

    const record = await this.consentService.accept(
      session.user.id,
      AI_DISCLOSURE_CONSENT_VERSION,
      metadata,
    );
    await this.auditService.log({
      actorId: session.user.id,
      action: 'ai.disclosure_acknowledged',
      entity: 'ConsentRecord',
      entityId: record.id,
      meta: {
        version: AI_DISCLOSURE_CONSENT_VERSION,
        agreements: AI_DISCLOSURE_AGREEMENT_IDS,
      },
    });
    return { acknowledged: true, record };
  }
}
