import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { DashboardService } from './dashboard.service.js';
import { Roles } from '../common/guards/roles.decorator.js';

@ApiTags('Counsellor Dashboard (contract)')
@Controller('v1/dashboard')
@Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('counsellor')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Counsellor review portal' })
  @ApiEnvelopeOk(Object)
  counsellor(@Session() session: UserSession) {
    return this.dashboardService.counsellor(session.user.id);
  }
}
