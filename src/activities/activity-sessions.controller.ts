import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { CompleteActivitySessionDto } from './dto/complete-activity-session.dto.js';
import { ActivitiesService } from './activities.service.js';

@ApiTags('Activities (contract)')
@Controller('v1/activity-sessions')
export class ActivitySessionsController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Patch(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Complete an activity session (owner only)',
    description:
      'Records the feel-after signal. Idempotent: completing an already-completed session returns it unchanged (measurement data is never overwritten).',
  })
  @ApiBody({ type: CompleteActivitySessionDto })
  @ApiEnvelopeOk(Object)
  complete(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: CompleteActivitySessionDto,
  ) {
    return this.activitiesService.complete(session.user.id, id, body);
  }
}
