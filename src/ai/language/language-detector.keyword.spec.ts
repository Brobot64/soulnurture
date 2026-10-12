import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import type { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import type { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { LanguageDetectorService } from './language-detector.service.js';

/** A vernacular safety phrase names its own language, even when no other
 * signal does (no diacritics, too few lexicon words, models silent). */
describe('LanguageDetectorService — safety phrases name their language', () => {
  let detector: LanguageDetectorService;

  beforeEach(() => {
    detector = new LanguageDetectorService(
      { configured: false, completeLabel: vi.fn() } as unknown as NatlasLlmProvider,
      { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { record: vi.fn() } as unknown as AiUsageMeterService,
      { openai: { model: 'x' }, language: { identifyMaxOutputTokens: 64, natlasIdentifyTimeoutMs: 4000 } } as unknown as AiConfig,
    );
  });

  it('a Hausa phrase with no other signal is read as Hausa by its keyword', async () => {
    expect(await detector.detect('Ina so in kashe kaina yanzu')).toEqual({
      lang: 'ha',
      confidence: 'medium',
      method: 'keyword',
    });
  });

  it('a Yoruba phrase without diacritics is read as Yoruba by its keyword', async () => {
    expect((await detector.detect('Mo fe ku')).lang).toBe('yo');
  });

  it('a Pidgin phrase is read as Pidgin by its keyword, not franc', async () => {
    expect((await detector.detect('I wan kill myself, I tire for everything')).lang).toBe('pcm');
  });

  it('a Hausa phrase the model mis-identifies is still Hausa: the keyword wins over the model', async () => {
    // Live N-ATLaS said "Yoruba" for this sentence; the keyword is decisive.
    const detector2 = new LanguageDetectorService(
      {
        configured: true,
        completeLabel: vi.fn().mockResolvedValue({ text: 'Language: Yoruba\nMeaning: x', usage: {} }),
      } as unknown as NatlasLlmProvider,
      { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { record: vi.fn() } as unknown as AiUsageMeterService,
      { openai: { model: 'x' }, language: { identifyMaxOutputTokens: 64, natlasIdentifyTimeoutMs: 4000 } } as unknown as AiConfig,
    );
    expect((await detector2.detect('ina so in mutu')).lang).toBe('ha');
  });

  it('an English safety phrase is still English', async () => {
    const detection = await detector.detect('I want to die, nothing matters anymore');
    expect(detection.lang).toBe('en');
    expect(detection.method).not.toBe('keyword');
  });
});
