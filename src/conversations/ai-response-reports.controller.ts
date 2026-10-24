import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { REVIEWER_ROLES, Roles } from '../common/guards/roles.decorator.js';
import { ApiEnvelopeOk, ApiSessionAuth, ApiStandardErrors } from '../docs/openapi.helpers.js';
import { AiResponseReportsService } from './ai-response-reports.service.js';
import { CreateAiResponseReportDto, ListAiResponseReportsDto, MyAiResponseReportsDto, ReviewAiResponseReportDto } from './dto/ai-response-report.dto.js';

@ApiTags('AI response reports')
@ApiSessionAuth()
@ApiStandardErrors()
@Controller('v1/ai-response-reports')
@Roles(...REVIEWER_ROLES)
export class AiResponseReportsController {
  constructor(private readonly reports: AiResponseReportsService) {}

  @Post()
  @Roles('STUDENT')
  @HttpCode(200)
  @ApiOperation({ summary: 'Report an owned assistant response', description: 'Saves the current response and optional note once per message. Retries return the existing report unchanged. Does not create a support request or trigger an escalation.' })
  @ApiBody({ type: CreateAiResponseReportDto })
  @ApiEnvelopeOk(Object)
  submit(@Session() session: UserSession, @Body() dto: CreateAiResponseReportDto) {
    return this.reports.submit(session.user.id, dto);
  }

  @Get('mine')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Read report receipts for an owned conversation' })
  @ApiEnvelopeOk(Object)
  mine(@Session() session: UserSession, @Query() query: MyAiResponseReportsDto) {
    return this.reports.mine(session.user.id, query.conversationId);
  }

  @Get()
  @ApiOperation({ summary: 'List AI response reports from the reviewer’s school' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession, @Query() query: ListAiResponseReportsDto) {
    return this.reports.list(session.user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a same-school AI response report without recording a review' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEnvelopeOk(Object)
  getOne(@Session() session: UserSession, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.getOne(session.user.id, id);
  }

  @Patch(':id/review')
  @ApiOperation({
    summary: 'Record a reviewer decision on a same-school AI response report',
    description:
      'Record-only: stores the outcome (NO_CHANGE_NEEDED / FOLLOWED_UP_WITH_STUDENT / CANNOT_ASSESS), the reviewer and the timestamp on the report and writes a metadata-only audit entry. It does not change the AI reply, the student’s conversation, memory or the reported text, creates no support request and notifies no one. Repeating the same decision as the same reviewer is idempotent; a different decision replaces it (last decision wins). A report from another school answers 404.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: ReviewAiResponseReportDto })
  @ApiEnvelopeOk(Object)
  review(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewAiResponseReportDto,
  ) {
    return this.reports.review(session.user.id, id, dto.outcome);
  }
}
