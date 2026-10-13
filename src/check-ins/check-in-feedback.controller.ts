import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { CheckInFeedbackService } from './check-in-feedback.service.js';
import { CreateCheckInFeedbackDto } from './dto/create-check-in-feedback.dto.js';

@ApiTags('Check-ins (contract)')
@Controller('v1/check-ins')
export class CheckInFeedbackController {
  constructor(private readonly feedbackService: CheckInFeedbackService) {}

  @Post(':id/feedback')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Submit post-check-in mood feedback',
    description: `
One "how do you feel now?" answer per check-in, on the same feeling/intensity
scale as the check-in itself. Re-submitting for the same check-in is a 409.
`,
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: CreateCheckInFeedbackDto })
  @ApiEnvelopeOk(Object)
  submit(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateCheckInFeedbackDto,
  ) {
    return this.feedbackService.submit(session.user.id, id, body);
  }

  @Get(':id/feedback')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Get the feedback submitted for a check-in',
    description: 'Returns `{ feedback: null }` until the student answers.',
  })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getForCheckIn(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.feedbackService.getForCheckIn(session.user.id, id);
  }
}
