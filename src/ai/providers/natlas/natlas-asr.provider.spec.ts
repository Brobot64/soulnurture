import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AiConfig } from '../../config/ai.config.js';
import { NAtlasAsrProvider } from './natlas-asr.provider.js';

const YO_ENDPOINT = 'https://yo.endpoints.huggingface.cloud';

function configWith(
  baseUrl: string | null,
  endpoints: Partial<Record<'yo' | 'ha' | 'ig', string>> = {},
): AiConfig {
  return {
    transcription: {
      model: 'whisper-large-v3-turbo',
      natlas: {
        endpoints,
        baseUrl,
        timeoutMs: 60_000,
        languages: ['yo', 'ha', 'ig'],
      },
    },
  } as unknown as AiConfig;
}

function secretsWith(apiKey = ''): ConfigService {
  return {
    get: vi.fn((key: string) =>
      key === 'NATLAS_ASR_API_KEY' ? apiKey : undefined,
    ),
  } as unknown as ConfigService;
}

function provider(
  baseUrl: string | null = null,
  endpoints: Partial<Record<'yo' | 'ha' | 'ig', string>> = {},
  apiKey = '',
): NAtlasAsrProvider {
  return new NAtlasAsrProvider(configWith(baseUrl, endpoints), secretsWith(apiKey));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const input = {
  buffer: Buffer.from('fake-webm-bytes'),
  filename: 'note.webm',
  mimeType: 'audio/webm',
  language: 'yo',
};

const wavInput = {
  buffer: Buffer.from('fake-wav-bytes'),
  filename: 'voice-note.wav',
  mimeType: 'audio/wav',
  language: 'yo',
};

describe('NAtlasAsrProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('hosted HF Inference Endpoint', () => {
    it('posts the raw audio bytes to the language endpoint and returns its text', async () => {
      let capturedUrl: string | undefined;
      let capturedBody = '';
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedBody = Buffer.from(init.body as Uint8Array).toString();
          capturedHeaders = init.headers as Record<string, string>;
          return jsonResponse({ text: 'Báwo ni?' });
        }),
      );

      const result = await provider(null, { yo: YO_ENDPOINT }, 'hf_test').transcribeAudio(wavInput);

      expect(capturedUrl).toBe(YO_ENDPOINT);
      expect(capturedBody).toBe('fake-wav-bytes');
      expect(capturedHeaders['Content-Type']).toBe('audio/wav');
      expect(capturedHeaders.Authorization).toBe('Bearer hf_test');
      expect(result).toEqual({ text: 'Báwo ni?' });
    });

    it('sends no Authorization header when the endpoint token is unset', async () => {
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedHeaders = init.headers as Record<string, string>;
          return jsonResponse({ text: 'Ndewo' });
        }),
      );

      await provider(null, { ig: YO_ENDPOINT }).transcribeAudio({
        ...wavInput,
        language: 'ig',
      });

      expect(capturedHeaders.Authorization).toBeUndefined();
    });

    it('prefers the endpoint over the sidecar for the same language', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ text: 'Báwo ni?' }));
      vi.stubGlobal('fetch', fetchMock);

      await provider('http://127.0.0.1:8100', { yo: YO_ENDPOINT }).transcribeAudio(wavInput);

      expect(fetchMock).toHaveBeenCalledWith(
        YO_ENDPOINT,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('falls back to the sidecar for a language that has no endpoint', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ text: 'Sannu', duration: 2 }));
      vi.stubGlobal('fetch', fetchMock);

      await provider('http://127.0.0.1:8100', { yo: YO_ENDPOINT }).transcribeAudio({
        ...wavInput,
        language: 'ha',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8100/transcribe',
        expect.anything(),
      );
    });

    it('degrades to the friendly message when the endpoint answers non-ok', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'malformed' }, 400)));

      const error = await provider(null, { yo: YO_ENDPOINT })
        .transcribeAudio(wavInput)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as Error).message).toContain('Yoruba');
      expect((error as Error).message).toContain('type your message instead');
    });

    it('degrades to the friendly message when the endpoint is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('timeout'))));

      await expect(
        provider(null, { yo: YO_ENDPOINT }).transcribeAudio(wavInput),
      ).rejects.toThrow(/Yoruba.*type your message instead/s);
    });

    it('degrades when the endpoint body carries no text', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ generated_text: 'Báwo ni?' })));

      await expect(
        provider(null, { yo: YO_ENDPOINT }).transcribeAudio(wavInput),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('returns the transcript when a retry finds the replica awake', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'waking' }, 503))
        .mockResolvedValue(jsonResponse({ text: 'Báwo ni?' }));
      vi.stubGlobal('fetch', fetchMock);

      const pending = provider(null, { yo: YO_ENDPOINT }).transcribeAudio(wavInput);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toEqual({ text: 'Báwo ni?' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up on a replica that never wakes and says it is starting up', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'waking' }, 503));
      vi.stubGlobal('fetch', fetchMock);

      const pending = provider(null, { yo: YO_ENDPOINT })
        .transcribeAudio(wavInput)
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(25_000);
      const error = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as Error).message).toContain('Yoruba voice model is starting up');
    });
  });

  describe('self-hosted sidecar', () => {
    it('posts the audio to the sidecar and returns text + duration', async () => {
      let capturedUrl: string | undefined;
      let capturedBody: FormData | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedBody = init.body as FormData;
          return jsonResponse({ text: 'Báwo ni?', duration: 3.42 });
        }),
      );

      const result = await provider('http://127.0.0.1:8100').transcribeAudio(input);

      expect(capturedUrl).toBe('http://127.0.0.1:8100/transcribe');
      expect(capturedBody).toBeInstanceOf(FormData);
      expect(capturedBody?.get('lang')).toBe('yo');
      const file = capturedBody?.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe('note.webm');
      expect(result).toEqual({ text: 'Báwo ni?', durationSeconds: 3.42 });
    });

    it('degrades to the friendly message when the sidecar answers non-ok', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'boom' }, 503)));

      const error = await provider('http://127.0.0.1:8100')
        .transcribeAudio(input)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as Error).message).toContain('Yoruba');
      expect((error as Error).message).toContain('type your message instead');
    });

    it('degrades to the friendly message when the sidecar is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('timeout'))));

      await expect(provider('http://127.0.0.1:8100').transcribeAudio(input)).rejects.toThrow(
        /Yoruba.*type your message instead/s,
      );
    });

    it('degrades without calling fetch when neither back-end is configured', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(provider().transcribeAudio(input)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('degrades when the sidecar body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 })),
      );

      await expect(
        provider('http://127.0.0.1:8100').transcribeAudio({ ...input, language: 'ha' }),
      ).rejects.toThrow(/Hausa.*type your message instead/s);
    });

    it('degrades when the sidecar JSON has no text', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ duration: 3.1 })));

      await expect(provider('http://127.0.0.1:8100').transcribeAudio(input)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
