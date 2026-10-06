import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { FollowUpsService } from './follow-ups.service.js';
import {
  CreateFollowUpDto,
  UpdateFollowUpDto,
} from './dto/follow-up.dto.js';

@ApiTags('Counsellor Dashboard (contract)')
@Controller('v1/follow-ups')
@Roles('STUDENT', 'COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List follow-ups' })
  @ApiEnvelopeOkArray(Object)
  list(@Session() session: UserSession) {
    return this.followUpsService.listForUser(session.user.id);
  }

  @Post()
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Create follow-up for a student' })
  @ApiBody({ type: CreateFollowUpDto })
  @ApiEnvelopeOk(Object)
  create(@Session() session: UserSession, @Body() body: CreateFollowUpDto) {
    return this.followUpsService.create(session.user.id, body);
  }

  @Patch(':id')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Update a follow-up (status plus notes)' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateFollowUpDto })
  @ApiEnvelopeOk(Object)
  update(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFollowUpDto,
  ) {
    return this.followUpsService.update(session.user.id, id, body);
  }
}
