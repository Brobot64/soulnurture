import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { PilotAnalyticsService } from './pilot-analytics.service.js';

@ApiTags('Platform admin — pilot analytics')
@Controller('v1/admin/pilot')
@Roles('PLATFORM_ADMIN')
export class PilotAnalyticsController {
  constructor(private readonly pilotAnalyticsService: PilotAnalyticsService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Pilot analytics (platform admin)',
    description: `
Aggregate-only pilot dashboard payload: reach overview, engagement (DAU/WAU/
MAU, new vs returning, return rate), feature usage, self-reported wellbeing
themes, resources, human support and safeguarding — never individual students.
Window: \`days\` preset (default 30) or an explicit \`from\`/\`to\` pair
(YYYY-MM-DD, inclusive, custom / pilot-period ranges). Optional \`schoolId\`
scopes to one school. Breakdown cells backed by 1–4 distinct students are
suppressed. Class/cohort filters are not offered yet — groups are too small
to keep non-identifying.
`,
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Preset window in days, 1–366 (default 30)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Custom window start (YYYY-MM-DD, inclusive); requires `to`',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Custom window end (YYYY-MM-DD, inclusive); requires `from`',
  })
  @ApiQuery({
    name: 'schoolId',
    required: false,
    description: 'Scope the window to a single school',
  })
  @ApiEnvelopeOk(Object)
  analytics(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('schoolId') schoolId?: string,
  ) {
    return this.pilotAnalyticsService.pilotAnalytics({ days, from, to, schoolId });
  }

  @Get('report')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Pilot aggregate report export (platform admin)',
    description: `
The same window payload as \`GET /v1/admin/pilot\`, flattened into a CSV
attachment (Pilot Reach, Engagement, Wellbeing Trends, Resources, Support,
Safeguarding, Outcomes). Aggregate only — no student identifiers, no PII.
Bypasses the JSON envelope: the response body is the raw CSV file.
`,
  })
  @ApiQuery({ name: 'days', required: false, description: 'Preset window in days, 1–366 (default 30)' })
  @ApiQuery({ name: 'from', required: false, description: 'Custom window start (YYYY-MM-DD, inclusive); requires `to`' })
  @ApiQuery({ name: 'to', required: false, description: 'Custom window end (YYYY-MM-DD, inclusive); requires `from`' })
  @ApiQuery({ name: 'schoolId', required: false, description: 'Scope the window to a single school' })
  async report(
    @Query('days') days: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('schoolId') schoolId: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const { csv, filename } = await this.pilotAnalyticsService.pilotReport({
      days,
      from,
      to,
      schoolId,
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  }
}
