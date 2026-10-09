import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('Notifications')
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List my notifications (newest first, take 50)' })
  @ApiQuery({
    name: 'unread',
    required: false,
    description: 'true → only unread notifications',
  })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession, @Query('unread') unread?: string) {
    return this.notifications.list(session.user.id, {
      unreadOnly: unread === 'true',
    });
  }

  @Get('unread-count')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'My unread notification count',
    description: 'Initial load / reconnect fallback for the badge — live updates arrive via WebSocket.',
  })
  @ApiEnvelopeOk(Object)
  unreadCount(@Session() session: UserSession) {
    return this.notifications.unreadCount(session.user.id);
  }

  @Post(':id/read')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Mark one notification read',
    description:
      'Idempotent; emits the fresh unread count to my sockets when the state actually changed.',
  })
  @ApiEnvelopeOk(Object)
  markRead(@Session() session: UserSession, @Param('id') id: string) {
    return this.notifications.markRead(session.user.id, id);
  }

  @Post('read-all')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Mark all my notifications read' })
  @ApiEnvelopeOk(Object)
  markAllRead(@Session() session: UserSession) {
    return this.notifications.markAllRead(session.user.id);
  }
}
