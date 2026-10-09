import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import { ReplyRendererService } from './reply-renderer.service.js';
import {
  NatlasLlmProvider,
  NatlasUnavailableError,
} from '../providers/natlas/natlas-llm.provider.js';
import type { LanguageDetectorService } from './language-detector.service.js';
import type { AiUsageMeterService } from '../providers/usage-meter.service.js';

const aiConfig = {
  openai: { model: 'gpt-5.6-luna' },
  language: {
    natlasBaseUrl: 'https://endpoint.example.cloud/',
    natlasModel: 'NCAIR1/N-ATLaS',
    natlasRenderTimeoutMs: 12_000,
    renderMaxOutputTokens: 400,
    understandingTimeoutMs: 15_000,
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

function openAiBody(content: string, usage?: object) {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

const renderInput = {
  englishReply: 'I am glad you told me. I am right here with you.',
  language: 'yo' as const,
  contextLines: ['Student: Jude O.', 'The student just wrote: mi o ti jeun lati aaro'],
};

describe('ReplyRendererService', () => {
  let completeText: ReturnType<typeof vi.fn>;
  let meter: { record: ReturnType<typeof vi.fn> };
  let detector: { detect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    completeText = vi.fn();
    meter = { record: vi.fn().mockResolvedValue(1) };
    // Silent heuristics by default: verification passes, no retry.
    detector = {
      detect: vi.fn().mockResolvedValue({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildService(natlasConfigured = true) {
    return new ReplyRendererService(
      configWith({ OPENAI_API_KEY: 'sk-test' }),
      { configured: natlasConfigured, completeText } as unknown as NatlasLlmProvider,
      meter as unknown as AiUsageMeterService,
      detector as unknown as LanguageDetectorService,
      aiConfig,
    );
  }

  it('renders via N-ATLaS, verifies heuristics-only and meters n-atlas-local with latency', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    completeText.mockResolvedValue({
      text: 'Inu mi dùn pé o sọ fun mi.',
      usage: { inputTokens: 30, outputTokens: 15 },
    });
    detector.detect.mockResolvedValue({
      lang: 'yo',
      confidence: 'high',
      method: 'diacritics',
    });

    const outcome = await buildService().render(renderInput);

    expect(outcome).toMatchObject({
      rendered: 'Inu mi dùn pé o sọ fun mi.',
      via: 'n-atlas-local',
      verified: true,
      attempts: 1,
    });
    expect(detector.detect).toHaveBeenCalledWith('Inu mi dùn pé o sọ fun mi.', {
      allowModel: false,
    });
    expect(completeText).toHaveBeenCalledTimes(1);
    expect(meter.record).toHaveBeenCalledWith('n-atlas-local', {
      inputTokens: 30,
      outputTokens: 15,
      latencyMs: expect.any(Number),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const [systemPrompt, userContent] = completeText.mock.calls[0] as string[];
    expect(systemPrompt).toContain('render ONE English reply');
    expect(systemPrompt).toContain('Yoruba');
    expect(userContent).toContain('English reply to render:');
    expect(userContent).toContain(renderInput.englishReply);
    expect(userContent).toContain('The student just wrote: mi o ti jeun lati aaro');
  });

  it('retries once when the render reads back as another language, keeping the verified retry', async () => {
    completeText
      .mockResolvedValueOnce({
        text: 'I am right here with you.',
        usage: { inputTokens: 30, outputTokens: 12 },
      })
      .mockResolvedValueOnce({
        text: 'Mo wà níbí pẹ̀lú rẹ.',
        usage: { inputTokens: 30, outputTokens: 11 },
      });
    detector.detect
      .mockResolvedValueOnce({ lang: 'en', confidence: 'medium', method: 'franc' })
      .mockResolvedValueOnce({ lang: 'yo', confidence: 'high', method: 'diacritics' });

    const outcome = await buildService().render(renderInput);

    expect(completeText).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      rendered: 'Mo wà níbí pẹ̀lú rẹ.',
      verified: true,
      attempts: 2,
    });
  });

  it('keeps the best-effort render and reports unverified when both attempts read back wrong', async () => {
    completeText.mockResolvedValue({
      text: 'I am right here with you.',
      usage: {},
    });
    detector.detect.mockResolvedValue({
      lang: 'en',
      confidence: 'medium',
      method: 'franc',
    });

    const outcome = await buildService().render(renderInput);

    expect(completeText).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      rendered: 'I am right here with you.',
      verified: false,
      attempts: 2,
    });
  });

  it('keeps an unverified first attempt when the retry produces nothing', async () => {
    completeText
      .mockResolvedValueOnce({ text: 'I am right here with you.', usage: {} })
      .mockRejectedValueOnce(new NatlasUnavailableError('cold again'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    detector.detect.mockResolvedValue({
      lang: 'en',
      confidence: 'medium',
      method: 'franc',
    });

    const outcome = await buildService().render(renderInput);

    expect(completeText).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      rendered: 'I am right here with you.',
      verified: false,
      attempts: 1,
    });
  });

  it('strips quotes the model wrapped around the rendered text', async () => {
    completeText.mockResolvedValue({
      text: '“Mo wà níbí fún ọ.”',
      usage: {},
    });

    const outcome = await buildService().render(renderInput);

    expect(outcome?.rendered).toBe('Mo wà níbí fún ọ.');
  });

  it('falls back to OpenAI when the N-ATLaS render fails and meters with latency', async () => {
    completeText.mockRejectedValue(new NatlasUnavailableError('cold start'));
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse(
          openAiBody('Mo wà níbí fún ọ.', {
            prompt_tokens: 18,
            completion_tokens: 9,
          }),
        );
      }),
    );

    const outcome = await buildService().render(renderInput);

    expect(outcome).toMatchObject({ rendered: 'Mo wà níbí fún ọ.', via: 'openai' });
    expect(meter.record).toHaveBeenCalledWith('openai', {
      inputTokens: 18,
      outputTokens: 9,
      latencyMs: expect.any(Number),
    });
    expect(capturedBody).toMatchObject({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 400,
    });
    expect(capturedBody).not.toHaveProperty('response_format');
  });

  it('returns null when every render lane fails — never throws', async () => {
    completeText.mockRejectedValue(new NatlasUnavailableError('down'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    await expect(buildService().render(renderInput)).resolves.toBeNull();
  });

  it('skips the N-ATLaS lane when it is not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(openAiBody('Rendered.'))),
    );

    const outcome = await buildService(false).render(renderInput);

    expect(outcome?.via).toBe('openai');
    expect(completeText).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalledWith(
      'n-atlas-local',
      expect.anything(),
    );
  });

  it('returns null when no lane is available at all', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new ReplyRendererService(
      configWith({}),
      { configured: false, completeText } as unknown as NatlasLlmProvider,
      meter as unknown as AiUsageMeterService,
      detector as unknown as LanguageDetectorService,
      aiConfig,
    );

    await expect(service.render(renderInput)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
