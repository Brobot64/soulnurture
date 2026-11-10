import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { AttentionService } from './attention.service.js';
import { Roles } from '../common/guards/roles.decorator.js';

/**
 * Separate from `DashboardController` on purpose: that one is gated to the
 * roles with a review queue, and a school admin has a rail to badge too.
 */
@ApiTags('Dashboard attention counts')
@Controller('v1/dashboard')
@Roles(
  'COUNSELLOR',
  'PSYCHOLOGIST',
  'SUPPORT_STAFF',
  'SCHOOL_ADMIN',
  'PLATFORM_ADMIN',
)
export class AttentionController {
  constructor(private readonly attentionService: AttentionService) {}

  @Get('attention')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Needs-attention counts for the staff rail badges',
  })
  @ApiEnvelopeOk(Object)
  attentionCounts(@Session() session: UserSession) {
    return this.attentionService.counts(session.user.id);
  }
}
