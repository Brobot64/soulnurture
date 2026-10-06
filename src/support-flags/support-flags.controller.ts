import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { MessageDataDto } from '../common/dto/api-response.dto.js';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { SupportFlagsService } from './support-flags.service.js';
import { Roles } from '../common/guards/roles.decorator.js';

@ApiTags('Support Flags (contract)')
@Controller('v1/support-flags')
@Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
export class SupportFlagsController {
  constructor(private readonly supportFlagsService: SupportFlagsService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List support flags' })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiEnvelopeOk(Object)
  list(
    @Session() session: UserSession,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
  ) {
    return this.supportFlagsService.list(session.user.id, {
      severity,
      status,
    });
  }

  @Post(':id/acknowledge')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Acknowledge flag' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(MessageDataDto)
  acknowledge(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supportFlagsService.acknowledge(session.user.id, id);
  }

  @Post(':id/in-review')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Mark flag in-review' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(MessageDataDto)
  inReview(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supportFlagsService.markInReview(session.user.id, id);
  }
}
