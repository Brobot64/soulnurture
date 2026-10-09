import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../config/ai.config.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import type { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import { LanguageDetectorService } from './language-detector.service.js';

const aiConfig = {
  openai: { model: 'gpt-5.6-luna' },
  language: {
    openaiIdentifyTimeoutMs: 8_000,
    openaiIdentifyMaxOutputTokens: 200,
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

function openAiBody(content: string): object {
  return { choices: [{ message: { content } }] };
}

describe('LanguageDetectorService', () => {
  let detector: LanguageDetectorService;
  let natlasLlm: { configured: boolean; completeLabel: ReturnType<typeof vi.fn> };
  let env: Record<string, string>;

  beforeEach(() => {
    env = {};
    natlasLlm = { configured: false, completeLabel: vi.fn() };
    detector = new LanguageDetectorService(
      configWith(env),
      natlasLlm as unknown as NatlasLlmProvider,
      aiConfig,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects Yoruba from its diacritics', async () => {
    expect(await detector.detect('Mo ti rẹ̀ rẹ̀ lónìí')).toEqual({
      lang: 'yo',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it('detects Hausa from its hooked letters', async () => {
    expect(await detector.detect('Ina jin ɓacin rai sosai')).toEqual({
      lang: 'ha',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it('detects Igbo from its diacritics', async () => {
    expect(await detector.detect('Obi m na-akụ nke ukwuu')).toEqual({
      lang: 'ig',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it("falls through on a shared-letter tie ('ọ' is both Yoruba and Igbo)", async () => {
    const detection = await detector.detect('ọ');
    expect(detection.lang).toBeNull();
    expect(detection.method).toBe('fallback');
  });

  it('detects Pidgin with two markers at medium confidence', async () => {
    expect(await detector.detect('Abeg dey')).toEqual({
      lang: 'pcm',
      confidence: 'medium',
      method: 'pidgin-markers',
    });
  });

  it('detects Pidgin with three markers at high confidence', async () => {
    expect(await detector.detect('Abeg wetin dey happen')).toEqual({
      lang: 'pcm',
      confidence: 'high',
      method: 'pidgin-markers',
    });
  });

  it('counts phrase markers before franc would call Pidgin English', async () => {
    expect(await detector.detect('No vex, e don finish')).toEqual({
      lang: 'pcm',
      confidence: 'medium',
      method: 'pidgin-markers',
    });
  });

  it('treats a single Pidgin marker as noise', async () => {
    const detection = await detector.detect('dey');
    expect(detection.lang).not.toBe('pcm');
    expect(detection.method).not.toBe('pidgin-markers');
  });

  it('detects English via franc at medium confidence', async () => {
    const detection = await detector.detect(
      'We walked to the market together and bought some oranges for our friends.',
    );
    expect(detection).toEqual({
      lang: 'en',
      confidence: 'medium',
      method: 'franc',
    });
  });

  it('falls back to a null language for short ambiguous text', async () => {
    expect(await detector.detect('ok')).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
  });

  it('detects pure Yoruba via the lexicon (franc says ibo for this text)', async () => {
    expect(
      await detector.detect('mi o ti jeun lati aaro mo fe lo ile mi'),
    ).toEqual({
      lang: 'yo',
      confidence: 'high',
      method: 'lexicon',
    });
  });

  it('detects Yoruba inside a mixed English message', async () => {
    const detection = await detector.detect(
      "I'm feeling sad. I think it's because of school. mi o ti jeun lati aaro mo fe lo ile mi",
    );
    expect(detection.lang).toBe('yo');
    expect(detection.method).toBe('lexicon');
  });

  it('detects Hausa via the lexicon', async () => {
    expect(await detector.detect('yanzu ina kwana a gida')).toEqual({
      lang: 'ha',
      confidence: 'medium',
      method: 'lexicon',
    });
  });

  it('detects Igbo via the lexicon', async () => {
    expect(await detector.detect('nne nna ndewo gini')).toEqual({
      lang: 'ig',
      confidence: 'medium',
      method: 'lexicon',
    });
  });

  it('never lets franc assert a Nigerian language', async () => {
    // Pre-lexicon, "I am happy" was misread as hausa by franc.
    expect(await detector.detect('I am happy')).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
  });

  it('does not fire on lone 2-letter Yoruba words', async () => {
    const detection = await detector.detect('mo mi fe');
    expect(detection.lang).not.toBe('yo');
    expect(detection.method).toBe('fallback');
  });

  describe('model stage (N-ATLaS language ID)', () => {
    beforeEach(() => {
      natlasLlm.configured = true;
    });

    it('asks N-ATLaS when every heuristic is silent — Hausa without diacritics', async () => {
      const text = 'Ina jin dadi amma ba zan iya sanya jin dadi ba';
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Language: Hausa\nMeaning: I am happy but I cannot hide my happiness.',
        usage: {},
      });

      expect(await detector.detect(text)).toEqual({
        lang: 'ha',
        confidence: 'medium',
        method: 'model',
      });
      expect(natlasLlm.completeLabel).toHaveBeenCalledWith(
        expect.stringContaining('Language: <the language'),
        text,
      );
    });

    it('reads the language header, never the meaning line’s stray codes', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Language: Hausa\nMeaning: Yo, I am happy but I cannot hide my happiness. Ha!',
        usage: {},
      });

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya jin dadi ba'),
      ).toEqual({ lang: 'ha', confidence: 'medium', method: 'model' });
    });

    it("an 'Other' header is an explicit non-answer — kept as fallback", async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Language: French\nMeaning: I am happy.',
        usage: {},
      });

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya jin dadi ba'),
      ).toEqual({ lang: null, confidence: 'low', method: 'fallback' });
    });

    it('detects Igbo typed without diacritics via the model', async () => {
      natlasLlm.completeLabel.mockResolvedValue({ text: 'ig', usage: {} });

      expect(
        await detector.detect(
          'O di m mma mana enweghi m ike itinye mmetuta ahu',
        ),
      ).toEqual({ lang: 'ig', confidence: 'medium', method: 'model' });
    });

    it('diacritics still beat the model — marked Igbo never reaches it', async () => {
      const detection = await detector.detect(
        'Ọ dị m mma mana enweghị m ike itinye mmetụta ahu',
      );

      expect(detection).toEqual({
        lang: 'ig',
        confidence: 'high',
        method: 'diacritics',
      });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('short English ends up English via the model (the old franc misread)', async () => {
      natlasLlm.completeLabel.mockResolvedValue({ text: 'en', usage: {} });

      expect(await detector.detect('I am happy')).toEqual({
        lang: 'en',
        confidence: 'medium',
        method: 'model',
      });
    });

    it('parses a spelled-out language name with punctuation', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Hausa.',
        usage: {},
      });

      expect(await detector.detect('Ina jin dadi sosai yau')).toEqual({
        lang: 'ha',
        confidence: 'medium',
        method: 'model',
      });
    });

    it('parses a language name wearing its own diacritics', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Èdè Yorùbá',
        usage: {},
      });

      expect(await detector.detect('Mo ri e ni oko')).toEqual({
        lang: 'yo',
        confidence: 'medium',
        method: 'model',
      });
    });

    it("an 'unknown' answer keeps the fallback verdict", async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'unknown',
        usage: {},
      });

      expect(await detector.detect('blorp zzzz')).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
      expect(natlasLlm.completeLabel).toHaveBeenCalledTimes(1);
    });

    it('a confident heuristic answer never reaches the model', async () => {
      const detection = await detector.detect(
        'mi o ti jeun lati aaro mo fe lo ile mi',
      );

      expect(detection.method).toBe('lexicon');
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('never asks below the minimum length or without letters', async () => {
      await detector.detect('ok');
      await detector.detect('12345678');
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('never asks under allowModel: false — the render-verification path', async () => {
      natlasLlm.completeLabel.mockResolvedValue({ text: 'ha', usage: {} });

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya jin dadi ba', {
          allowModel: false,
        }),
      ).toEqual({ lang: null, confidence: 'low', method: 'fallback' });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('still runs every heuristic under allowModel: false', async () => {
      expect(
        await detector.detect('Mo ti rẹ̀ rẹ̀ lónìí', { allowModel: false }),
      ).toEqual({ lang: 'yo', confidence: 'high', method: 'diacritics' });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('stays on the preference fallback while the endpoint is unconfigured', async () => {
      natlasLlm.configured = false;

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya ba'),
      ).toEqual({ lang: null, confidence: 'low', method: 'fallback' });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
    });

    it('fails open when the model call throws', async () => {
      natlasLlm.completeLabel.mockRejectedValue(new Error('cold start'));

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya ba'),
      ).toEqual({ lang: null, confidence: 'low', method: 'fallback' });
    });

    it('fails open when the model answers something unparsable', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'fr maybe?',
        usage: {},
      });

      expect(
        await detector.detect('Ina jin dadi amma ba zan iya sanya ba'),
      ).toEqual({ lang: null, confidence: 'low', method: 'fallback' });
    });
  });

  describe('OpenAI identify fallback', () => {
    const silentText = 'Ina jin dadi amma ba zan iya sanya jin dadi ba';

    beforeEach(() => {
      natlasLlm.configured = true;
      env.OPENAI_API_KEY = 'sk-test';
    });

    it('falls back to OpenAI when the N-ATLaS lane is unavailable (paused endpoint)', async () => {
      natlasLlm.completeLabel.mockRejectedValue(
        new Error('N-ATLaS endpoint rejected the request with status 400'),
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(openAiBody('Language: Hausa\nMeaning: I am happy.')),
        );
      vi.stubGlobal('fetch', fetchMock);

      expect(await detector.detect(silentText)).toEqual({
        lang: 'ha',
        confidence: 'medium',
        method: 'model',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(OPENAI_CHAT_URL);
      expect(init.headers).toEqual({
        Authorization: 'Bearer sk-test',
        'Content-Type': 'application/json',
      });
      const body = JSON.parse(init.body as string) as {
        model: string;
        max_completion_tokens: number;
        messages: { role: string; content: string }[];
      };
      expect(body.model).toBe('gpt-5.6-luna');
      expect(body.max_completion_tokens).toBe(200);
      expect(body.messages[0].content).toContain('Language: <the language');
      expect(body.messages[1].content).toBe(silentText);
      expect(body).not.toHaveProperty('response_format');
    });

    it('runs the OpenAI lane directly when N-ATLaS is unconfigured', async () => {
      natlasLlm.configured = false;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            openAiBody(
              'Language: Igbo\nMeaning: It is fine but I cannot express that feeling.',
            ),
          ),
        );
      vi.stubGlobal('fetch', fetchMock);

      expect(
        await detector.detect(
          'O di m mma mana enweghi m ike itinye mmetuta ahu',
        ),
      ).toEqual({ lang: 'ig', confidence: 'medium', method: 'model' });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an N-ATLaS verdict still wins — OpenAI is never asked', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Language: Hausa\nMeaning: I am happy.',
        usage: {},
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await detector.detect(silentText)).toEqual({
        lang: 'ha',
        confidence: 'medium',
        method: 'model',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an explicit 'Other' header from N-ATLaS is honoured — OpenAI is not asked", async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'Language: French\nMeaning: I am happy.',
        usage: {},
      });
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await detector.detect(silentText)).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a header-less unparsable N-ATLaS answer falls through to OpenAI', async () => {
      natlasLlm.completeLabel.mockResolvedValue({
        text: 'fr maybe?',
        usage: {},
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(openAiBody('yo')));
      vi.stubGlobal('fetch', fetchMock);

      expect(await detector.detect('Mo ri e ni oko')).toEqual({
        lang: 'yo',
        confidence: 'medium',
        method: 'model',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails open when OpenAI itself errors (HTTP status)', async () => {
      natlasLlm.completeLabel.mockRejectedValue(new Error('cold start'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)),
      );

      expect(await detector.detect(silentText)).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
    });

    it('fails open when fetch itself throws', async () => {
      natlasLlm.completeLabel.mockRejectedValue(new Error('cold start'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      expect(await detector.detect(silentText)).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
    });

    it('fails open when the OpenAI answer is unparsable too', async () => {
      natlasLlm.completeLabel.mockRejectedValue(new Error('cold start'));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(openAiBody('no idea, sorry'))),
      );

      expect(await detector.detect(silentText)).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
    });

    it('stays a no-op when neither lane is configured', async () => {
      natlasLlm.configured = false;
      delete env.OPENAI_API_KEY;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await detector.detect(silentText)).toEqual({
        lang: null,
        confidence: 'low',
        method: 'fallback',
      });
      expect(natlasLlm.completeLabel).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
