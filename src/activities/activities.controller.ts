import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { ActivityQueryDto } from './dto/activity-query.dto.js';
import { StartActivitySessionDto } from './dto/start-activity-session.dto.js';
import { ActivitiesService } from './activities.service.js';

@ApiTags('Activities (contract)')
@Controller('v1/activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'List approved activities',
    description:
      'Active + approved catalogue only. Cards omit the renderer `steps` — fetch the detail or start a session for the full step contract.',
  })
  @ApiQuery({ name: 'category', required: false })
  @ApiEnvelopeOk(Object)
  list(@Query() query: ActivityQueryDto) {
    return this.activitiesService.list(query);
  }

  @Get('me/sessions')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'My activity session history',
    description:
      'Most recent 50 sessions with the feel-after signal (completedAt + feelingAfter) for the wellbeing journey view.',
  })
  @ApiEnvelopeOk(Object)
  history(@Session() session: UserSession) {
    return this.activitiesService.history(session.user.id);
  }

  @Get(':slug')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Activity detail with renderer steps',
    description:
      'Full `steps` renderer contract (breath-pacing | timer | prompt-list | body-scan).',
  })
  @ApiEnvelopeOk(Object)
  detail(@Param('slug') slug: string) {
    return this.activitiesService.detail(slug);
  }

  @Post(':slug/sessions')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Start an activity session',
    description:
      'Opens a session and returns the full renderer steps. `conversationId` (optional) binds the run to the conversation it came from and marks it as AI-recommended; the conversation must belong to the caller.',
  })
  @ApiBody({ type: StartActivitySessionDto })
  @ApiEnvelopeOk(Object)
  start(
    @Session() session: UserSession,
    @Param('slug') slug: string,
    @Body() body: StartActivitySessionDto,
  ) {
    return this.activitiesService.start(session.user.id, slug, body);
  }
}
