import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { AuditService } from '../audit/audit.service.js';
import { ROLES_KEY } from '../common/guards/roles.decorator.js';
import type { NatlasEndpointStatus } from './providers/natlas/natlas-endpoints.service.js';
import { NatlasEndpointsService } from './providers/natlas/natlas-endpoints.service.js';
import { AiAdminController } from './ai-admin.controller.js';

const WAKING: NatlasEndpointStatus = {
  id: 'asr-yo',
  purpose: 'asr',
  language: 'yo',
  label: 'Yoruba voice notes',
  model: 'NCAIR1 whisper-small fine-tune',
  state: 'waking',
  httpStatus: 503,
  latencyMs: 41,
};

const INFO = {
  id: 'asr-yo',
  purpose: 'asr' as const,
  language: 'yo' as const,
  label: 'Yoruba voice notes',
  model: 'NCAIR1 whisper-small fine-tune',
  configured: true,
};

function build(endpoints: Partial<NatlasEndpointsService> = {
  describe: vi.fn(() => [INFO]),
  probeAll: vi.fn(async () => [WAKING]),
}) {
  const log = vi.fn(async () => undefined);
  const audit = { log } as unknown as AuditService;
  return {
    controller: new AiAdminController(
      endpoints as NatlasEndpointsService,
      audit,
    ),
    endpoints,
    log,
  };
}

const session = { user: { id: 'admin-1' } } as UserSession;

describe('AiAdminController', () => {
  it('is platform-admin only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AiAdminController)).toEqual([
      'PLATFORM_ADMIN',
    ]);
  });

  it('lists the configuration without asking any endpoint for a replica', () => {
    const { controller, endpoints } = build();

    expect(controller.list()).toEqual([INFO]);

    expect(endpoints.probeAll).not.toHaveBeenCalled();
  });

  it('returns what each endpoint answered when waking', async () => {
    const { controller } = build();

    await expect(controller.wake(session)).resolves.toEqual([WAKING]);
  });

  it('audits the wake against the acting admin', async () => {
    const { controller, log } = build();

    await controller.wake(session);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'ai.endpoints_woken',
        entity: 'AiEndpoint',
      }),
    );
  });

  it('audits only the state, never a label, URL or token', async () => {
    const { controller, log } = build();

    await controller.wake(session);

    expect(log.mock.calls[0]?.[0]).toEqual({
      actorId: 'admin-1',
      action: 'ai.endpoints_woken',
      entity: 'AiEndpoint',
      meta: {
        endpoints: [{ id: 'asr-yo', state: 'waking', httpStatus: 503 }],
      },
    });
  });
});
