import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AiGenerationError } from '../../ai.errors.js';
import type { AiConfig } from '../../config/ai.config.js';
import { OpenAiProvider } from './openai.provider.js';

const aiConfig = {
  chat: { attemptTimeoutMs: 20_000 },
  openai: { model: 'gpt-5.6-luna', maxOutputTokens: 1000 },
} as unknown as AiConfig;

const modelJson = {
  message: 'hello',
  emotion: { detected: null, confidence: null },
  reflection: { question: null, insight: null },
  resource: { recommended: false, resourceId: null },
  humanSupport: { recommended: false, type: null, reason: null },
  supportFlag: { candidate: false, category: null, severity: null },
  action: 'REFLECTION',
};

function configWith(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws AiGenerationError without a key and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiProvider(configWith({}), aiConfig);

    await expect(
      provider.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(AiGenerationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a strict json_schema body and attaches usage tokens', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify(modelJson) } }],
          usage: { prompt_tokens: 12, completion_tokens: 34 },
        });
      }),
    );
    const provider = new OpenAiProvider(
      configWith({ OPENAI_API_KEY: 'sk-test' }),
      aiConfig,
    );

    const result = await provider.generateResponse({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(capturedBody).toMatchObject({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 1000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ai_generation_result', strict: true },
      },
    });
    expect(capturedBody).not.toHaveProperty('temperature');
    const responseFormat = capturedBody?.response_format as {
      json_schema: { schema: Record<string, unknown> };
    };
    expect(responseFormat.json_schema.schema).not.toHaveProperty('usage');
    expect(result).toMatchObject({ message: 'hello' });
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(34);
    expect(result.usage?.latencyMs).toBeTypeOf('number');
  });

  it('sends temperature only when OPENAI_TEMPERATURE is explicitly set', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify(modelJson) } }],
        });
      }),
    );
    const provider = new OpenAiProvider(
      configWith({ OPENAI_API_KEY: 'sk-test', OPENAI_TEMPERATURE: '0.4' }),
      aiConfig,
    );

    await provider.generateResponse({ systemPrompt: 's', messages: [] });

    expect(capturedBody?.temperature).toBe(0.4);
  });

  it('maps non-OK statuses, timeouts, and empty bodies to AiGenerationError', async () => {
    const provider = new OpenAiProvider(
      configWith({ OPENAI_API_KEY: 'sk-test' }),
      aiConfig,
    );

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'x' }, 429)));
    await expect(
      provider.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(/status 429/);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })),
    );
    await expect(
      provider.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(/empty response/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(
      provider.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(AiGenerationError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(
      provider.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(/unreachable/);
  });

  it('does not offer transcription — the chain routes voice elsewhere', async () => {
    const provider = new OpenAiProvider(
      configWith({ OPENAI_API_KEY: 'sk-test' }),
      aiConfig,
    );

    await expect(
      provider.transcribeAudio({
        buffer: Buffer.from('x'),
        filename: 'a.webm',
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
