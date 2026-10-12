import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import type { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import type { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { LanguageDetectorService } from './language-detector.service.js';

/** Silent to every offline heuristic: unmarked Hausa, no diacritics. */
const UNMARKED_HAUSA = 'Ina so in yi magana da wani a gida';

const aiConfigStub = {
  openai: { model: 'gpt-test' },
  language: { identifyMaxOutputTokens: 64, natlasIdentifyTimeoutMs: 4_000 },
} as unknown as AiConfig;

function openAiReply(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }], usage: {} }),
  } as unknown as Response;
}

describe('LanguageDetectorService — OpenAI fallback for the model stage', () => {
  let natlasLlm: { configured: boolean; completeLabel: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let meter: { record: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;
  let detector: LanguageDetectorService;

  beforeEach(() => {
    natlasLlm = { configured: true, completeLabel: vi.fn() };
    config = {
      get: vi.fn((key: string) => (key === 'OPENAI_API_KEY' ? 'sk-test' : undefined)),
    };
    meter = { record: vi.fn().mockResolvedValue(undefined) };
    fetchMock = vi.fn().mockResolvedValue(
      openAiReply('Language: Hausa\nMeaning: I feel like killing myself.'),
    );
    vi.stubGlobal('fetch', fetchMock);
    detector = new LanguageDetectorService(
      natlasLlm as unknown as NatlasLlmProvider,
      config as unknown as ConfigService,
      meter as unknown as AiUsageMeterService,
      aiConfigStub,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to OpenAI when N-ATLaS is not configured', async () => {
    natlasLlm.configured = false;

    expect(await detector.detect(UNMARKED_HAUSA)).toEqual({
      lang: 'ha',
      confidence: 'medium',
      method: 'model',
    });
    expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      OPENAI_CHAT_URL,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back to OpenAI when N-ATLaS throws (cold start, outage)', async () => {
    natlasLlm.completeLabel.mockRejectedValue(new Error('N-ATLaS down'));

    expect(await detector.detect(UNMARKED_HAUSA)).toEqual({
      lang: 'ha',
      confidence: 'medium',
      method: 'model',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call OpenAI when N-ATLaS answers', async () => {
    natlasLlm.completeLabel.mockResolvedValue({
      text: 'Language: Hausa\nMeaning: I feel like killing myself.',
      usage: {},
    });

    expect((await detector.detect(UNMARKED_HAUSA)).lang).toBe('ha');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the OpenAI identify call against the usage meter', async () => {
    natlasLlm.configured = false;

    await detector.detect(UNMARKED_HAUSA);

    expect(meter.record).toHaveBeenCalledWith('openai', expect.any(Object));
  });

  it('stays on the fallback when no OpenAI key is configured', async () => {
    natlasLlm.configured = false;
    config.get.mockReturnValue(undefined);

    expect(await detector.detect(UNMARKED_HAUSA)).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays on the fallback when both N-ATLaS and OpenAI are unavailable', async () => {
    natlasLlm.completeLabel.mockRejectedValue(new Error('N-ATLaS down'));
    fetchMock.mockRejectedValue(new Error('network unreachable'));

    expect(await detector.detect(UNMARKED_HAUSA)).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
  });

  it('stays on the fallback when OpenAI answers something unparsable', async () => {
    natlasLlm.configured = false;
    fetchMock.mockResolvedValue(openAiReply('I cannot tell, sorry.'));

    expect((await detector.detect(UNMARKED_HAUSA)).lang).toBeNull();
  });
});
