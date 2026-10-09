import { Test, TestingModule } from '@nestjs/testing';
import { REALTIME_EVENTS } from './realtime.events.js';
import { RealtimeService } from './realtime.service.js';

describe('RealtimeService', () => {
  let service: RealtimeService;
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  const server = {
    to: vi.fn().mockReturnValue({ emit }),
    in: vi.fn().mockReturnValue({ disconnectSockets }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [RealtimeService],
    }).compile();
    service = module.get(RealtimeService);
  });

  it('no-ops before the gateway attaches a server', () => {
    expect(() =>
      service.emitToUser('u1', REALTIME_EVENTS.NOTIFICATION_NEW, {}),
    ).not.toThrow();
  });

  it('targets exactly the personal room', () => {
    service.setServer(server as never);

    service.emitToUser('u1', REALTIME_EVENTS.NOTIFICATION_NEW, { id: 'n1' });

    expect(server.to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith(REALTIME_EVENTS.NOTIFICATION_NEW, {
      id: 'n1',
    });
  });

  it('targets exactly the school professionals room', () => {
    service.setServer(server as never);

    service.emitToSchoolProfessionals('s1', REALTIME_EVENTS.CHAT_REQUEST_CREATED, {
      threadId: 't1',
    });

    expect(server.to).toHaveBeenCalledWith('school-professionals:s1');
    expect(emit).toHaveBeenCalledWith(REALTIME_EVENTS.CHAT_REQUEST_CREATED, {
      threadId: 't1',
    });
  });

  it('force-drops every socket in the personal room', () => {
    service.setServer(server as never);

    service.disconnectUser('u1');

    expect(server.in).toHaveBeenCalledWith('user:u1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });
});
