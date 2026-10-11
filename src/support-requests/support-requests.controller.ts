import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { CreateSupportRequestDto } from './dto/create-support-request.dto.js';
import { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';
import { QUEUE_STATUSES, type QueueStatus } from './queue-status.js';
import { SupportRequestsService } from './support-requests.service.js';

@ApiTags('Support Requests (contract)')
@Controller('v1/support-requests')
export class SupportRequestsController {
  constructor(
    private readonly supportRequestsService: SupportRequestsService,
  ) {}

  @Get('people')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List trusted support people' })
  @ApiEnvelopeOkArray(Object)
  people() {
    return this.supportRequestsService.listPeople();
  }

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Create support request' })
  @ApiBody({ type: CreateSupportRequestDto })
  @ApiEnvelopeOk(Object)
  create(
    @Session() session: UserSession,
    @Body() body: CreateSupportRequestDto,
  ) {
    return this.supportRequestsService.create(session.user.id, body);
  }

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List own support requests' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.supportRequestsService.listMine(session.user.id);
  }

  /**
   * Staff review queue (figma node 146:914). Declared before `:id` so the
   * literal segment wins over the UUID param.
   */
  @Get('queue')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary:
      'Staff queue: school support requests with derived review status, prompt, counts',
  })
  @ApiQuery({ name: 'status', required: false, enum: QUEUE_STATUSES })
  @ApiQuery({ name: 'q', required: false })
  @ApiEnvelopeOk(Object)
  listQueue(
    @Session() session: UserSession,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    let queueStatus: QueueStatus | undefined;
    if (status !== undefined) {
      if (!QUEUE_STATUSES.includes(status as QueueStatus)) {
        throw new BadRequestException(
          `status must be one of ${QUEUE_STATUSES.join(', ')}`,
        );
      }
      queueStatus = status as QueueStatus;
    }
    return this.supportRequestsService.listQueue(session.user.id, {
      status: queueStatus,
      q,
    });
  }

  @Get(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get support request' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getOne(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supportRequestsService.getOne(session.user.id, id);
  }

  @Patch(':id')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Professional review: set status plus review note',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: ReviewSupportRequestDto })
  @ApiEnvelopeOk(Object)
  review(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewSupportRequestDto,
  ) {
    return this.supportRequestsService.review(session.user.id, id, body);
  }
}
