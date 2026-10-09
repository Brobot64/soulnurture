import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { normalizeWindowDays } from './analytics.constants.js';
import { AnalyticsService } from './analytics.service.js';

@ApiTags('Platform admin — analytics')
@Controller('v1/admin')
@Roles('PLATFORM_ADMIN')
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Platform analytics (platform admin)',
    description: `
Windowed day series (new users, check-ins, chat threads, messages), fixed 7d
vs previous 7d deltas, mood distribution rolled up to the eight student mood
faces, and weekday check-in bars. \`days\` is 14, 30 or 90 (default 14).
`,
  })
  @ApiQuery({ name: 'days', required: false, description: '14, 30 or 90 (default 14)' })
  @ApiEnvelopeOk(Object)
  analytics(@Query('days') days?: string) {
    return this.analyticsService.platformAnalytics(normalizeWindowDays(days));
  }

  @Get('activity')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Platform activity feed (platform admin)',
    description:
      'Audit rows for schools, people and chat with actor and school labels resolved.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  @ApiQuery({
    name: 'kind',
    required: false,
    description: 'all (default), schools, people or chat',
  })
  @ApiEnvelopeOk(Object)
  activity(@Query('limit') limit?: string, @Query('kind') kind?: string) {
    return this.analyticsService.platformActivity(limit, kind);
  }
}
