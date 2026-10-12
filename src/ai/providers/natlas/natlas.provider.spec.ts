import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../../config/ai.config.js';
import { AiGenerationError } from '../../ai.errors.js';
import { NatlasTranslationProvider } from './natlas.provider.js';
import {
  NatlasLlmProvider,
  NatlasUnavailableError,
} from './natlas-llm.provider.js';
import type { AiUsageMeterService } from '../usage-meter.service.js';

/** Translation is N-ATLaS-only: OpenAI never translates. The synchronous
 * translation has a short deadline so a cold endpoint cannot hold a reply. */
const aiConfig = {
  openai: { model: 'gpt-5.6-luna' },
  language: {
    natlasBaseUrl: 'http://vps:11434',
    natlasModel: 'n-atlas',
    understandingMaxOutputTokens: 120,
    understandingTimeoutMs: 15_000,
    natlasTranslateTimeoutMs: 10_000,
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

describe('NatlasTranslationProvider (N-ATLaS-only)', () => {
  let completeJson: ReturnType<typeof vi.fn>;
  let meter: { record: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    completeJson = vi.fn();
    meter = { record: vi.fn().mockResolvedValue(1) };
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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

  it('calls N-ATLaS with the short translation deadline', async () => {
    completeJson.mockResolvedValue({ raw: validUnderstanding, usage: {} });

    await buildProvider().understand({ text: 'Ina jin ɓacin rai sosai', language: 'ha' });

    expect(completeJson).toHaveBeenCalledWith(
      expect.any(String),
      'Ina jin ɓacin rai sosai',
      10_000,
    );
  });

  it('never calls OpenAI when the N-ATLaS endpoint fails: it throws instead', async () => {
    completeJson.mockRejectedValue(new NatlasUnavailableError('VPS down'));

    await expect(
      buildProvider().understand({ text: 'Ina jin ɓacin rai sosai', language: 'ha' }),
    ).rejects.toBeInstanceOf(AiGenerationError);
    await expect(
      buildProvider().understand({ text: 'Ina jin ɓacin rai sosai', language: 'ha' }),
    ).rejects.toThrow(/Translation unavailable \(N-ATLaS: VPS down\)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(meter.record).not.toHaveBeenCalled();
  });

  it('throws when N-ATLaS returns an invalid payload, and never calls OpenAI', async () => {
    completeJson.mockResolvedValue({ raw: { englishTranslation: '' }, usage: {} });

    await expect(
      buildProvider().understand({ text: 'Obi m na-akụ nke ukwuu', language: 'ig' }),
    ).rejects.toBeInstanceOf(AiGenerationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when N-ATLaS is not configured, without calling OpenAI', async () => {
    await expect(
      buildProvider(false).understand({ text: 'Abeg I no dey happy at all', language: 'pcm' }),
    ).rejects.toThrow(/Translation unavailable \(N-ATLaS: not configured\)/);
    expect(completeJson).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
