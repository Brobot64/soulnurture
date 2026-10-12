import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import type { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import type { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { LanguageDetectorService } from './language-detector.service.js';

const aiConfigStub = {
  openai: { model: 'gpt-test' },
  language: { identifyMaxOutputTokens: 64, natlasIdentifyTimeoutMs: 4_000 },
} as unknown as AiConfig;

describe('LanguageDetectorService — code-switching and Pidgin', () => {
  let detector: LanguageDetectorService;

  beforeEach(() => {
    detector = new LanguageDetectorService(
      { configured: false, completeLabel: vi.fn() } as unknown as NatlasLlmProvider,
      { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      { record: vi.fn() } as unknown as AiUsageMeterService,
      aiConfigStub,
    );
  });

  describe('Hausa-English code-switching (item 3)', () => {
    it('reads a Hausa-English mix as Hausa at low confidence instead of English', async () => {
      expect(
        await detector.detect("Ina so in daina school, I can't do this again."),
      ).toEqual({ lang: 'ha', confidence: 'low', method: 'lexicon-mixed' });
    });

    it('keeps a plain English message English', async () => {
      expect(
        (await detector.detect('I feel overwhelmed today because of my exams.')).lang,
      ).toBe('en');
    });

    it('one stray local word in a long English sentence does not flip the language', async () => {
      const text =
        'I think my teacher is being really unfair to me and ina sure everyone in class agrees with her about it all week';
      expect((await detector.detect(text)).lang).toBe('en');
    });
  });

  describe('Pidgin with a single marker (item 4)', () => {
    it('detects a sentence with one strong Pidgin marker as Pidgin', async () => {
      expect(
        await detector.detect('The teacher dey shout at everybody in class today'),
      ).toEqual({ lang: 'pcm', confidence: 'medium', method: 'pidgin-markers' });
    });

    it('detects the Pidgin phrase "no fit" as a marker', async () => {
      expect(
        (await detector.detect('My chest dey beat fast, I no fit breathe, exam dey come tomorrow.')).lang,
      ).toBe('pcm');
    });

    it('detects "think say" as a Pidgin construction alongside "e don"', async () => {
      expect(
        (await detector.detect('E don small better. But I think say I go fail and my papa go kill me.')).lang,
      ).toBe('pcm');
    });

    it('still treats a lone marker in a single word as noise', async () => {
      expect((await detector.detect('dey')).method).not.toBe('pidgin-markers');
    });
  });
});
