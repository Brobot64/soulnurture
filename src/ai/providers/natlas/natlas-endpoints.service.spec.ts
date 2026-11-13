import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../../config/ai.config.js';
import { NatlasEndpointsService } from './natlas-endpoints.service.js';

const YO = 'https://yo.endpoints.huggingface.cloud';
const HA = 'https://ha.endpoints.huggingface.cloud';
const IG = 'https://ig.endpoints.huggingface.cloud';
const LLM = 'https://llm.endpoints.huggingface.cloud';

function aiConfigWith(
  endpoints: Partial<Record<'yo' | 'ha' | 'ig', string>>,
  natlasBaseUrl: string | null,
): AiConfig {
  return {
    transcription: {
      natlas: {
        endpoints,
        baseUrl: null,
        timeoutMs: 60_000,
        languages: ['yo', 'ha', 'ig'],
      },
    },
    language: { natlasBaseUrl, natlasModel: 'NCAIR1/N-ATLaS' },
  } as unknown as AiConfig;
}

function keys(asr = 'hf_asr_secret', llm = 'hf_llm_secret'): ConfigService {
  return {
    get: vi.fn((key: string) =>
      key === 'NATLAS_ASR_API_KEY'
        ? asr
        : key === 'NATLAS_LLM_API_KEY'
          ? llm
          : undefined,
    ),
  } as unknown as ConfigService;
}

function build(
  endpoints: Partial<Record<'yo' | 'ha' | 'ig', string>> = { yo: YO, ha: HA },
  natlasBaseUrl: string | null = LLM,
): NatlasEndpointsService {
  return new NatlasEndpointsService(aiConfigWith(endpoints, natlasBaseUrl), keys());
}

interface ProbeCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
}

/** Records every request that leaves the service and answers each with status. */
function recordFetches(status: number): ProbeCall[] {
  const calls: ProbeCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init.method,
        authorization: headers.Authorization,
      });
      return new Response(null, { status });
    }),
  );
  return calls;
}

describe('NatlasEndpointsService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('describe()', () => {
    it('lists all four endpoints from config without contacting any of them', () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const rows = build().describe();

      expect(rows.map((row) => row.id)).toEqual([
        'asr-yo',
        'asr-ha',
        'asr-ig',
        'llm-n-atlas',
      ]);
      expect(rows.filter((row) => row.configured).map((row) => row.id)).toEqual([
        'asr-yo',
        'asr-ha',
        'llm-n-atlas',
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names an endpoint by what it serves, never by its URL or token', () => {
      const json = JSON.stringify(build({ yo: YO }, null).describe());

      expect(json).toContain('Yoruba voice notes');
      expect(json).not.toContain('huggingface');
      expect(json).not.toContain('hf_asr_secret');
      expect(json).not.toContain('hf_llm_secret');
    });
  });

  describe('probeAll()', () => {
    it('reports a 2xx as awake and a 503 as still waking', async () => {
      recordFetches(200);
      expect((await build().probeAll())[0].state).toBe('awake');

      vi.unstubAllGlobals();
      recordFetches(503);
      const waking = await build({ yo: YO }).probeAll();
      expect(waking.find((row) => row.id === 'asr-yo')?.state).toBe('waking');
      expect(
        waking.find((row) => row.id === 'asr-ig')?.state,
      ).toBe('not_configured');
    });

    it('reports a host that answered something else as reached, not running', async () => {
      recordFetches(404);

      const [yo] = await build({ yo: YO }).probeAll();

      expect(yo?.state).toBe('reached');
      expect(yo?.httpStatus).toBe(404);
    });

    it('reports a probe that never answered as unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('fetch failed');
        }),
      );

      const [yo] = await build({ yo: YO }).probeAll();

      expect(yo?.state).toBe('unreachable');
      expect(yo?.httpStatus).toBeNull();
    });

    it('sends a GET to each configured URL with that lane token, and none elsewhere', async () => {
      const calls = recordFetches(503);

      await build({ yo: YO, ha: HA, ig: IG }, null).probeAll();

      expect(calls).toHaveLength(3);
      expect(calls.map((call) => call.url)).toEqual([YO, HA, IG]);
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(calls.every((call) => call.authorization === 'Bearer hf_asr_secret')).toBe(
        true,
      );
    });

    it('authorizes the chat endpoint with its own token', async () => {
      const calls = recordFetches(200);

      await build({}, LLM).probeAll();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(LLM);
      expect(calls[0]?.authorization).toBe('Bearer hf_llm_secret');
    });

    it('never returns a URL or a token with the statuses', async () => {
      recordFetches(200);

      const json = JSON.stringify(await build().probeAll());

      expect(json).not.toContain('huggingface');
      expect(json).not.toContain('hf_asr_secret');
      expect(json).not.toContain('hf_llm_secret');
    });

    it('times an answer and leaves the unconfigured rows untimed', async () => {
      recordFetches(200);

      const statuses = await build({ yo: YO }).probeAll();

      expect(typeof statuses[0]?.latencyMs).toBe('number');
      const unconfigured = statuses.find((row) => row.id === 'asr-ig');
      expect(unconfigured?.latencyMs).toBeNull();
      expect(unconfigured?.httpStatus).toBeNull();
    });
  });
});
