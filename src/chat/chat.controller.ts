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
import { Roles } from '../common/guards/roles.decorator.js';
import {
  ApiEnvelopeOk,
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { ChatService } from './chat.service.js';
import { CreateChatThreadDto } from './dto/create-chat-thread.dto.js';
import { SendChatMessageDto } from './dto/send-chat-message.dto.js';

const CHAT_STAFF = ['COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF'] as const;

@ApiTags('Chat (contract)')
@Controller('v1/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('threads')
  @Roles('STUDENT')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Ask to talk with a professional (creates a PENDING request)',
  })
  @ApiBody({ type: CreateChatThreadDto })
  @ApiEnvelopeOk(Object)
  createThread(
    @Session() session: UserSession,
    @Body() body: CreateChatThreadDto,
  ) {
    return this.chatService.createThread(session.user.id, body);
  }

  @Get('threads')
  @Roles('STUDENT', ...CHAT_STAFF)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'List my threads (students: own requests; staff: claimed ones)',
  })
  @ApiEnvelopeOkArray(Object)
  listThreads(@Session() session: UserSession) {
    return this.chatService.listThreads(session.user.id);
  }

  @Get('inbox')
  @Roles(...CHAT_STAFF)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: "The school's shared PENDING pool (oldest first)" })
  @ApiEnvelopeOkArray(Object)
  inbox(@Session() session: UserSession) {
    return this.chatService.inbox(session.user.id);
  }

  @Get('unread')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'My unread chat counts ({total, byThread})' })
  @ApiEnvelopeOk(Object)
  unread(@Session() session: UserSession) {
    return this.chatService.unreadSummary(session.user.id);
  }

  @Get('threads/:id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Full thread with messages (participants only)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEnvelopeOk(Object)
  getThread(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.getThread(session.user.id, id);
  }

  @Post('threads/:id/claim')
  @Roles(...CHAT_STAFF)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Claim a PENDING request (first professional wins)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEnvelopeOk(Object)
  claim(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.claim(session.user.id, id);
  }

  @Post('threads/:id/messages')
  @Roles('STUDENT', ...CHAT_STAFF)
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Send a message (voice text arrives viaVoice)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: SendChatMessageDto })
  @ApiEnvelopeOk(Object)
  sendMessage(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendChatMessageDto,
  ) {
    return this.chatService.sendMessage(session.user.id, id, body);
  }

  @Post('threads/:id/read')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Mark the thread read up to now' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEnvelopeOk(Object)
  markRead(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.readThread(session.user.id, id);
  }

  @Post('threads/:id/close')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Close the chat (idempotent)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiEnvelopeOk(Object)
  close(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.close(session.user.id, id);
  }
}
