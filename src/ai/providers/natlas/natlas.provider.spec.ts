import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../../config/ai.config.js';
import { NatlasTranslationProvider } from './natlas.provider.js';
import {
  NatlasLlmProvider,
  NatlasUnavailableError,
} from './natlas-llm.provider.js';
import type { AiUsageMeterService } from '../usage-meter.service.js';

const aiConfig = {
  openai: { model: 'gpt-5.6-luna' },
  language: {
    natlasBaseUrl: 'http://vps:11434',
    natlasModel: 'n-atlas',
    understandingMaxOutputTokens: 120,
    understandingTimeoutMs: 15_000,
  },
} as unknown as AiConfig;

const validUnderstanding = {
  englishTranslation: 'I feel very sad today.',
  tone: 'DISTRESSED',
  keyFacts: ['sadness'],
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

function openAiBody(content: string, usage?: object) {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

describe('NatlasTranslationProvider', () => {
  let completeJson: ReturnType<typeof vi.fn>;
  let meter: { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    completeJson = vi.fn();
    meter = { record: vi.fn().mockResolvedValue(1) };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildProvider(natlasConfigured = true) {
    return new NatlasTranslationProvider(
      configWith({ OPENAI_API_KEY: 'sk-test' }),
      { configured: natlasConfigured, completeJson } as unknown as NatlasLlmProvider,
      meter as unknown as AiUsageMeterService,
      aiConfig,
    );
  }

  it('returns the N-ATLaS understanding and meters n-atlas-local', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    completeJson.mockResolvedValue({
      raw: validUnderstanding,
      usage: { inputTokens: 12, outputTokens: 34 },
    });

    const outcome = await buildProvider().understand({
      text: 'Mo ti rẹ̀ rẹ̀ lónìí',
      language: 'yo',
    });

    expect(outcome.via).toBe('n-atlas-local');
    expect(outcome.understanding).toEqual({
      ...validUnderstanding,
      lang: 'yo',
      via: 'n-atlas-local',
    });
    expect(meter.record).toHaveBeenCalledWith('n-atlas-local', {
      inputTokens: 12,
      outputTokens: 34,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to OpenAI when the N-ATLaS endpoint fails and meters with latency', async () => {
    completeJson.mockRejectedValue(new NatlasUnavailableError('VPS down'));
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(
          openAiBody(JSON.stringify(validUnderstanding), {
            prompt_tokens: 21,
            completion_tokens: 8,
          }),
        );
      }),
    );

    const outcome = await buildProvider().understand({
      text: 'Ina jin ɓacin rai sosai',
      language: 'ha',
    });

    expect(outcome.via).toBe('openai');
    expect(outcome.understanding).toEqual({
      ...validUnderstanding,
      lang: 'ha',
      via: 'openai',
    });
    expect(meter.record).toHaveBeenCalledWith('openai', {
      inputTokens: 21,
      outputTokens: 8,
      latencyMs: expect.any(Number),
    });
    expect(capturedUrl).toContain('/chat/completions');
    expect(capturedBody).toMatchObject({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 120,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'message_understanding', strict: true },
      },
    });
    const messages = capturedBody?.messages as { role: string; content: string }[];
    expect(messages[0].content).toContain('Language: Hausa');
  });

  it('falls back when the N-ATLaS endpoint returns an invalid payload', async () => {
    completeJson.mockResolvedValue({
      raw: { englishTranslation: '' },
      usage: {},
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse(openAiBody(JSON.stringify(validUnderstanding))),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await buildProvider().understand({
      text: 'Obi m na-akụ nke ukwuu',
      language: 'ig',
    });

    expect(outcome.via).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meter.record).toHaveBeenCalledWith('openai', expect.anything());
  });

  it('skips the N-ATLaS lane entirely when it is not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(openAiBody(JSON.stringify(validUnderstanding)))),
    );

    const outcome = await buildProvider(false).understand({
      text: 'Abeg I no dey happy at all',
      language: 'pcm',
    });

    expect(outcome.via).toBe('openai');
    expect(completeJson).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalledWith(
      'n-atlas-local',
      expect.anything(),
    );
  });

  it('rejects with AiGenerationError when every lane fails', async () => {
    completeJson.mockRejectedValue(new NatlasUnavailableError('VPS down'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    await expect(
      buildProvider().understand({ text: 'x', language: 'yo' }),
    ).rejects.toThrow(/Vernacular understanding unavailable \(n-atlas-local: .*; openai: /);
    expect(meter.record).not.toHaveBeenCalled();
  });

  it('rejects when no OpenAI key is present and the N-ATLaS lane is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new NatlasTranslationProvider(
      configWith({}),
      { configured: false, completeJson } as unknown as NatlasLlmProvider,
      meter as unknown as AiUsageMeterService,
      aiConfig,
    );

    await expect(
      provider.understand({ text: 'x', language: 'yo' }),
    ).rejects.toThrow(/OpenAI translation provider is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
