import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import {
  schoolProfessionalsRoom,
  userRoom,
  type RealtimeEvent,
} from './realtime.events.js';

/**
 * The only place that touches the Socket.IO server. Every emit is
 * room-targeted (DB first, then emit): personal events go to `user:<id>`,
 * pool events to the school's professionals room — sockets of users
 * unauthorized for an event are in neither room and receive nothing.
 * No-ops before the gateway has attached the server (unit tests, REST-only
 * requests), so callers never need to guard.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  emitToUser(userId: string, event: RealtimeEvent, payload: unknown) {
    this.server?.to(userRoom(userId)).emit(event, payload);
  }

  emitToSchoolProfessionals(
    schoolId: string,
    event: RealtimeEvent,
    payload: unknown,
  ) {
    this.server?.to(schoolProfessionalsRoom(schoolId)).emit(event, payload);
  }

  /// Force-drop every live socket of a user (school suspension, deactivation).
  disconnectUser(userId: string) {
    this.server?.in(userRoom(userId)).disconnectSockets(true);
  }
}
