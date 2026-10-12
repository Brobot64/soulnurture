import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import { LANGUAGE_DISPLAY_NAMES } from '../../language/language.config.js';
import type { AsrVernacularLanguage } from '../../language/language.config.js';
import type {
  AiTranscriptionInput,
  AiTranscriptionResult,
} from '../ai-provider.interface.js';

/**
 * Vernacular voice notes (Yoruba / Hausa / Igbo) — NCAIR1 whisper-small
 * fine-tunes, reachable two ways, resolved per language:
 *
 *   1. a hosted HF Inference Endpoint (`NATLAS_ASR_URL_<LANG>`): raw audio
 *      bytes POSTed to the endpoint root, answer `{"text": "..."}`. The
 *      container decodes with libsndfile only, so it accepts wav/flac/mp3 and
 *      rejects the webm/opus MediaRecorder produces — the browser records WAV.
 *   2. the self-hosted FastAPI sidecar (`NATLAS_ASR_BASE_URL`): multipart
 *      file + lang to `/transcribe`, answer `{"text", "duration"}`.
 *
 * An endpoint wins over the sidecar for its own language, which lets one
 * language move to hosted inference without touching the others. A hosted
 * endpoint scales to zero when idle and then takes minutes to wake, so a 503
 * is retried inside the request budget and, if the replica never comes up,
 * reported as "starting up — try again" rather than as a dead lane.
 *
 * Unlike the chat chain, audio has no fallback member: when nothing is
 * configured, or the back-end is down, slow or answers garbage, the student
 * gets one friendly line asking them to type instead — never a raw error,
 * never silence.
 */
/** Measured on the hosted endpoints: a scaled-to-zero replica answers 503 in
 * ~1s and takes 2.5-3.5 min to come up (1 GB fp32 whisper checkpoint). One
 * attempt therefore always loses a cold start, so retry inside the caller's
 * timeout — that catches a replica a previous student already woke. */
const COLD_START_ATTEMPTS = 3;
const COLD_START_RETRY_DELAY_MS = 10_000;

@Injectable()
export class NAtlasAsrProvider {
  private readonly logger = new Logger(NAtlasAsrProvider.name);

  constructor(
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    private readonly config: ConfigService,
  ) {}

  /** Read through ConfigService so the token never enters AiConfig — that
   * object is exposed to professional roles by GET /api/v1/ai/config. */
  private get apiKey(): string {
    return this.config.get<string>('NATLAS_ASR_API_KEY')?.trim() ?? '';
  }

  async transcribeAudio(
    input: AiTranscriptionInput,
  ): Promise<AiTranscriptionResult> {
    const language = input.language ?? '';
    const { endpoints, baseUrl } = this.aiConfig.transcription.natlas;
    const endpoint = endpoints[language as AsrVernacularLanguage];

    if (endpoint) return this.viaEndpoint(endpoint, input, language);
    if (baseUrl) return this.viaSidecar(baseUrl, input, language);

    this.logger.warn(
      `Vernacular voice (${language}) requested but no NATLAS_ASR_URL_* endpoint and no NATLAS_ASR_BASE_URL sidecar are configured`,
    );
    throw new ServiceUnavailableException(this.unavailable(language));
  }

  private async viaEndpoint(
    url: string,
    input: AiTranscriptionInput,
    language: string,
  ): Promise<AiTranscriptionResult> {
    const { timeoutMs } = this.aiConfig.transcription.natlas;
    const deadline = Date.now() + timeoutMs;
    const headers: Record<string, string> = {
      'Content-Type': input.mimeType,
    };
    const apiKey = this.apiKey;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const body = new Uint8Array(input.buffer);

    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Vernacular ASR endpoint unreachable (${language}): ${message}`,
        );
        throw new ServiceUnavailableException(this.unavailable(language));
      }

      if (res.ok) {
        const json = (await res
          .json()
          .catch(() => null)) as { text?: unknown } | null;
        if (!json || typeof json.text !== 'string') {
          this.logger.warn(
            `Vernacular ASR endpoint returned an unexpected body (${language})`,
          );
          throw new ServiceUnavailableException(this.unavailable(language));
        }
        return { text: json.text };
      }

      const waking = res.status === 503;
      const retrying =
        waking &&
        attempt + 1 < COLD_START_ATTEMPTS &&
        Date.now() + COLD_START_RETRY_DELAY_MS < deadline;
      this.logger.warn(
        `Vernacular ASR endpoint answered ${res.status} (${language})` +
          (retrying ? ' — replica waking, retrying' : ''),
      );
      if (!retrying) {
        throw new ServiceUnavailableException(
          this.unavailable(language, waking),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, COLD_START_RETRY_DELAY_MS));
    }
  }

  private async viaSidecar(
    baseUrl: string,
    input: AiTranscriptionInput,
    language: string,
  ): Promise<AiTranscriptionResult> {
    const { timeoutMs } = this.aiConfig.transcription.natlas;

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.filename,
    );
    form.append('lang', language);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `N-ATLaS ASR sidecar unreachable (${language}): ${message}`,
      );
      throw new ServiceUnavailableException(this.unavailable(language));
    }

    if (!res.ok) {
      this.logger.warn(
        `N-ATLaS ASR sidecar rejected the request with status ${res.status} (${language})`,
      );
      throw new ServiceUnavailableException(this.unavailable(language));
    }

    const json = (await res.json().catch(() => null)) as {
      text?: unknown;
      duration?: unknown;
    } | null;

    if (!json || typeof json.text !== 'string') {
      this.logger.warn(
        `N-ATLaS ASR sidecar returned an unexpected body (${language})`,
      );
      throw new ServiceUnavailableException(this.unavailable(language));
    }

    return {
      text: json.text,
      durationSeconds:
        typeof json.duration === 'number' ? json.duration : undefined,
    };
  }

  private unavailable(language: string, waking = false): string {
    const name =
      LANGUAGE_DISPLAY_NAMES[language as keyof typeof LANGUAGE_DISPLAY_NAMES] ??
      'this language';
    if (waking) {
      return (
        `The ${name} voice model is starting up, which takes a couple of ` +
        `minutes — please try again in a moment, or type your message.`
      );
    }
    return (
      `Voice notes in ${name} are not available right now — ` +
      `please type your message instead.`
    );
  }
}
