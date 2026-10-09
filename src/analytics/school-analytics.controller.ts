import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { normalizeWindowDays } from './analytics.constants.js';
import { AnalyticsService } from './analytics.service.js';

@ApiTags('School admin — analytics')
@Controller('v1/schools')
@Roles('SCHOOL_ADMIN', 'PLATFORM_ADMIN')
export class SchoolAnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get(':id/analytics')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'School analytics (school admin)',
    description: `
Same windowed shape as the platform endpoint plus the school roster counts
(students, professionals, admins, deactivated) and onboarding completeness
(accounts still on the default password or unverified).
`,
  })
  @ApiQuery({ name: 'days', required: false, description: '14, 30 or 90 (default 14)' })
  @ApiEnvelopeOk(Object)
  analytics(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Query('days') days?: string,
  ) {
    return this.analyticsService.schoolAnalytics(
      session.user.id,
      id,
      normalizeWindowDays(days),
    );
  }

  @Get(':id/activity')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'School activity feed (school admin)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  @ApiQuery({
    name: 'kind',
    required: false,
    description: 'all (default), schools, people or chat',
  })
  @ApiEnvelopeOk(Object)
  activity(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('kind') kind?: string,
  ) {
    return this.analyticsService.schoolActivity(session.user.id, id, limit, kind);
  }
}
