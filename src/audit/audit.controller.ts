import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { AuditService } from './audit.service.js';

@ApiTags('Counsellor Dashboard (contract)')
@Controller('v1/audit')
@Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: "List this school's recent audit events",
    description:
      'Action metadata only, never wellbeing content, and scoped to the caller’s own school: an event is visible here when the school it belongs to is the school on the reviewer’s account. A staff account with no school is refused — it is entitled to no tenant’s trail.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiEnvelopeOk(Object)
  async list(
    @Session() session: UserSession,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Number(limit ?? 50) || 50, 100);
    return {
      items: await this.auditService.list(session.user.id, { take }),
    };
  }
}