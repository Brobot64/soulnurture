import {
  Body,
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
import { ReviewDecisionDto } from './dto/review-decision.dto.js';
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
  @ApiQuery({ name: 'level', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiEnvelopeOk(Object)
  list(
    @Session() session: UserSession,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('level') level?: string,
    @Query('q') q?: string,
  ) {
    return this.supportFlagsService.list(session.user.id, {
      severity,
      status,
      level,
      q,
    });
  }

  @Get(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Show one flag as four separate kinds of content' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  detail(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supportFlagsService.detail(session.user.id, id);
  }

  @Post(':id/review-decision')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Record the reviewer decision without advancing the workflow',
  })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(MessageDataDto)
  reviewDecision(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewDecisionDto,
  ) {
    return this.supportFlagsService.recordReviewDecision(
      session.user.id,
      id,
      body.decision,
    );
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
