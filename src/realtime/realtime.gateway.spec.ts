import { Test, TestingModule } from '@nestjs/testing';
import type { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

function makeClient(overrides: { headers?: Record<string, string> } = {}) {
  return {
    handshake: {
      headers: overrides.headers ?? {
        cookie: 'better-auth.session_token=session-token',
      },
    },
    join: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  } as unknown as Socket & { join: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
}

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;
  const authService = { getSession: vi.fn() };
  const prisma = { user: { findUnique: vi.fn() } };
  const realtime = {
    setServer: vi.fn(),
    emitToUser: vi.fn(),
    emitToSchoolProfessionals: vi.fn(),
    disconnectUser: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: AuthService, useValue: authService },
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    gateway = module.get(RealtimeGateway);
  });

  it('hands the socket.io server to the realtime service on init', () => {
    const server = { id: 'io' };
    gateway.afterInit(server as never);
    expect(realtime.setServer).toHaveBeenCalledWith(server);
  });

  it('resolves the session from the handshake cookies', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'u1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'STUDENT',
      schoolId: 's1',
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    const headers = authService.getSession.mock.calls[0][0] as Headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers.get('cookie')).toBe('better-auth.session_token=session-token');
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith('user:u1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated handshake with a disconnect', async () => {
    authService.getSession.mockRejectedValue(new Error('no session'));
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('joins a school professional to the pool room as well', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'p1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'p1',
      role: 'COUNSELLOR',
      schoolId: 's1',
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith('user:p1');
    expect(client.join).toHaveBeenCalledWith('school-professionals:s1');
  });

  it('keeps school admins out of the pool room (staff-only audience)', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'a1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'a1',
      role: 'SCHOOL_ADMIN',
      schoolId: 's1',
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith('user:a1');
  });

  it('keeps legacy users without a school on their personal room only', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'legacy' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'legacy',
      role: 'STUDENT',
      schoolId: null,
      deactivatedAt: null,
      mustChangePassword: false,
      school: null,
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith('user:legacy');
  });

  it('drops a suspended-school socket', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'u1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'STUDENT',
      schoolId: 's1',
      deactivatedAt: null,
      mustChangePassword: false,
      school: { status: 'SUSPENDED' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('drops a deactivated socket', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'u1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'STUDENT',
      schoolId: 's1',
      deactivatedAt: new Date(),
      mustChangePassword: false,
      school: { status: 'ACTIVE' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('drops a socket still flagged must-change-password', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'u1' } });
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      role: 'STUDENT',
      schoolId: 's1',
      deactivatedAt: null,
      mustChangePassword: true,
      school: { status: 'ACTIVE' },
    });
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('drops the socket when the account vanished between session and connection', async () => {
    authService.getSession.mockResolvedValue({ user: { id: 'ghost' } });
    prisma.user.findUnique.mockResolvedValue(null);
    const client = makeClient();

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });
});
