import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../../config/ai.config.js';
import {
  NatlasLlmProvider,
  NatlasUnavailableError,
} from './natlas-llm.provider.js';

const aiConfig = {
  language: {
    natlasBaseUrl: 'https://endpoint.example.cloud/',
    natlasModel: 'NCAIR1/N-ATLaS',
    natlasTimeoutMs: 45_000,
    natlasRenderTimeoutMs: 12_000,
    natlasIdentifyTimeoutMs: 4_000,
    understandingMaxOutputTokens: 120,
    renderMaxOutputTokens: 400,
    identifyMaxOutputTokens: 64,
  },
} as unknown as AiConfig;

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function chatBody(content: string, usage?: object) {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

describe('NatlasLlmProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildProvider(env: Record<string, string> = {}) {
    return new NatlasLlmProvider(aiConfig, configWith(env));
  }

  it('POSTs the OpenAI chat shape to /v1/chat/completions with bearer auth', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse(
          chatBody('{"englishTranslation":"x"}', {
            prompt_tokens: 7,
            completion_tokens: 3,
          }),
        );
      }),
    );

    const outcome = await buildProvider({ NATLAS_LLM_API_KEY: 'hf_test' })
      .completeJson('SYSTEM', 'USER');

    expect(capturedUrl).toBe(
      'https://endpoint.example.cloud/v1/chat/completions',
    );
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer hf_test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      model: 'NCAIR1/N-ATLaS',
      stream: false,
      temperature: 0.1,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'USER' },
      ],
    });
    expect(outcome).toEqual({
      raw: { englishTranslation: 'x' },
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  it('omits the Authorization header when no key is configured (dev Ollama)', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return jsonResponse(chatBody('{"ok":true}'));
      }),
    );

    await buildProvider().completeJson('sys', 'user');

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps a non-OK status to NatlasUnavailableError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'cold start' }, 503)),
    );

    await expect(
      buildProvider().completeJson('sys', 'user'),
    ).rejects.toThrow(/rejected the request with status 503/);
  });

  it('maps an unreachable endpoint to NatlasUnavailableError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    await expect(
      buildProvider().completeJson('sys', 'user'),
    ).rejects.toThrow(/unreachable/);
  });

  it('rejects an empty completion and non-JSON content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(chatBody(''))),
    );
    await expect(
      buildProvider().completeJson('sys', 'user'),
    ).rejects.toThrow(/empty response/);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(chatBody('not-json'))),
    );
    await expect(
      buildProvider().completeJson('sys', 'user'),
    ).rejects.toThrow(NatlasUnavailableError);
  });

  it('is not configured and never fetches when the base URL is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new NatlasLlmProvider(
      { language: { ...aiConfig.language, natlasBaseUrl: null } } as AiConfig,
      configWith({}),
    );

    expect(provider.configured).toBe(false);
    await expect(provider.completeJson('sys', 'user')).rejects.toThrow(
      /not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('completeText (reply render)', () => {
    it('POSTs the free-text shape with the render budget and trims the content', async () => {
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedInit = init;
          return jsonResponse(
            chatBody('  Mo wà níbí.  ', {
              prompt_tokens: 12,
              completion_tokens: 6,
            }),
          );
        }),
      );

      const outcome = await buildProvider({ NATLAS_LLM_API_KEY: 'hf_test' })
        .completeText('SYSTEM', 'USER');

      expect(JSON.parse(capturedInit?.body as string)).toEqual({
        model: 'NCAIR1/N-ATLaS',
        stream: false,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'USER' },
        ],
      });
      expect(outcome).toEqual({
        text: 'Mo wà níbí.',
        usage: { inputTokens: 12, outputTokens: 6 },
      });
    });

    it('rejects a whitespace-only completion', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(chatBody('   '))),
      );

      await expect(
        buildProvider().completeText('sys', 'user'),
      ).rejects.toThrow(/empty response/);
    });
  });

  describe('completeLabel (language ID)', () => {
    it('POSTs the translation-header shape with temperature 0 and the identify budget', async () => {
      let capturedInit: RequestInit | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedInit = init;
          return jsonResponse(
            chatBody('Language: Hausa\nMeaning: I am happy.', {
              prompt_tokens: 9,
              completion_tokens: 12,
            }),
          );
        }),
      );

      const outcome = await buildProvider({ NATLAS_LLM_API_KEY: 'hf_test' })
        .completeLabel('SYSTEM', 'USER');

      expect(JSON.parse(capturedInit?.body as string)).toEqual({
        model: 'NCAIR1/N-ATLaS',
        stream: false,
        temperature: 0,
        max_tokens: 64,
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'USER' },
        ],
      });
      expect(outcome).toEqual({
        text: 'Language: Hausa\nMeaning: I am happy.',
        usage: { inputTokens: 9, outputTokens: 12 },
      });
    });

    it('trims the label and rejects a whitespace-only completion', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(chatBody('  ha.\n'))),
      );
      const outcome = await buildProvider().completeLabel('sys', 'user');
      expect(outcome.text).toBe('ha.');

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(chatBody('   '))),
      );
      await expect(
        buildProvider().completeLabel('sys', 'user'),
      ).rejects.toThrow(/empty response/);
    });
  });
});
