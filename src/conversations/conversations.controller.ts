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
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { ConversationsService } from './conversations.service.js';
import { REVIEWER_ROLES, Roles } from '../common/guards/roles.decorator.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';

@ApiTags('Conversations & AI (contract)')
@Controller('v1/conversations')
@Roles('STUDENT')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Start conversation' })
  @ApiBody({ type: CreateConversationDto })
  @ApiEnvelopeOk(Object)
  create(
    @Session() session: UserSession,
    @Body() body: CreateConversationDto,
  ) {
    return this.conversationsService.create(session.user.id, body);
  }

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List conversations' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.conversationsService.listMine(session.user.id);
  }

  @Get(':id')
  @Roles('STUDENT', ...STAFF_ROLES)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get conversation' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getOne(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversationsService.getOne(session.user.id, id);
  }

  @Get(':id/review-context')
  @Roles(...REVIEWER_ROLES)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Read same-school AI summary and linked conversation for review',
    description: 'Counsellors and psychologists only. Returns the AI-generated summary (null if absent) and visible conversation messages, without recording a review or changing request status.',
  })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getReviewContext(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversationsService.getReviewContext(session.user.id, id);
  }

  @Post(':id/close')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Close conversation (queues an AI session summary)',
  })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  close(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversationsService.close(session.user.id, id);
  }

  @Post(':id/messages')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Send message (AI orchestrated)' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: SendMessageDto })
  @ApiEnvelopeOk(Object)
  send(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.conversationsService.sendMessage(session.user.id, id, body);
  }
}
