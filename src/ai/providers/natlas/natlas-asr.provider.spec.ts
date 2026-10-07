import { ServiceUnavailableException } from '@nestjs/common';
import type { AiConfig } from '../../config/ai.config.js';
import { NAtlasAsrProvider } from './natlas-asr.provider.js';

function configWith(baseUrl: string | null): AiConfig {
  return {
    transcription: {
      model: 'whisper-large-v3-turbo',
      natlas: {
        baseUrl,
        timeoutMs: 60_000,
        languages: ['yo', 'ha', 'ig'],
      },
    },
  } as unknown as AiConfig;
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

describe('NAtlasAsrProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

    const result = await new NAtlasAsrProvider(configWith('http://127.0.0.1:8100')).transcribeAudio(input);

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

    const error = await new NAtlasAsrProvider(configWith('http://127.0.0.1:8100'))
      .transcribeAudio(input)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toContain('Yoruba');
    expect((error as Error).message).toContain('type your message instead');
  });

  it('degrades to the friendly message when the sidecar is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('timeout'))));

    await expect(
      new NAtlasAsrProvider(configWith('http://127.0.0.1:8100')).transcribeAudio(input),
    ).rejects.toThrow(/Yoruba.*type your message instead/s);
  });

  it('degrades without calling fetch when the sidecar is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new NAtlasAsrProvider(configWith(null)).transcribeAudio(input),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades when the sidecar body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 })),
    );

    await expect(
      new NAtlasAsrProvider(configWith('http://127.0.0.1:8100')).transcribeAudio({
        ...input,
        language: 'ha',
      }),
    ).rejects.toThrow(/Hausa.*type your message instead/s);
  });

  it('degrades when the sidecar JSON has no text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ duration: 3.1 })));

    await expect(
      new NAtlasAsrProvider(configWith('http://127.0.0.1:8100')).transcribeAudio(input),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
