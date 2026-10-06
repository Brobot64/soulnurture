import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List recent audit events' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiEnvelopeOk(Object)
  async list(@Query('limit') limit?: string) {
    const take = Math.min(Number(limit ?? 50) || 50, 100);
    return {
      items: await this.auditService.list({ take }),
    };
  }
}