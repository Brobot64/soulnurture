import { Logger } from '@nestjs/common';
import {
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingHttpHeaders } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { STAFF_ROLES } from '../users/dto/staff-bootstrap.dto.js';
import {
  SOCKET_PATH,
  schoolProfessionalsRoom,
  userRoom,
} from './realtime.events.js';
import { RealtimeService } from './realtime.service.js';

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function headersFromHandshake(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return headers;
}

@WebSocketGateway({
  path: SOCKET_PATH,
  // WebSocket-only: engine.io's request interception does not survive
  // Fastify's request handling (polling handshakes 404 through to the
  // Nest 404 envelope), while the upgrade path works everywhere we ship.
  transports: ['websocket'],
  cors: {
    origin: (origin, callback) => {
      const origins = allowedOrigins();
      if (origins.length === 0 || !origin || origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed'));
      }
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit<Server> {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setServer(server);
  }

  /// Mandatory handshake auth: the Better Auth session is resolved from the
  /// handshake cookies (same as the REST guards) and the account state is
  /// re-verified from the DB — anonymous, deactivated, suspended-school and
  /// must-change-password sockets are all dropped. Rooms derive only from
  /// the verified session.
  async handleConnection(client: Socket) {
    try {
      const session = await this.authService.getSession(
        headersFromHandshake(client.handshake.headers),
      );
      const user = await this.prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          id: true,
          role: true,
          schoolId: true,
          deactivatedAt: true,
          mustChangePassword: true,
          school: { select: { status: true } },
        },
      });
      if (
        !user ||
        user.deactivatedAt ||
        user.mustChangePassword ||
        user.school?.status === 'SUSPENDED'
      ) {
        client.disconnect(true);
        return;
      }

      await client.join(userRoom(user.id));
      if (
        user.schoolId &&
        user.school?.status === 'ACTIVE' &&
        (STAFF_ROLES as readonly string[]).includes(user.role)
      ) {
        await client.join(schoolProfessionalsRoom(user.schoolId));
      }
    } catch (error) {
      this.logger.debug(
        `Socket handshake rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      client.disconnect(true);
    }
  }
}
