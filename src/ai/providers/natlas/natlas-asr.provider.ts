import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import { LANGUAGE_DISPLAY_NAMES } from '../../language/language.config.js';
import type { AiTranscriptionInput, AiTranscriptionResult } from '../ai-provider.interface.js';

/**
 * N-ATLaS ASR sidecar client (Phase C step 5).
 *
 * The local FastAPI sidecar (services/n-atlas-asr) serves the NCAIR1
 * whisper-small fine-tunes for Yoruba, Hausa and Igbo. Unlike the chat
 * chain, audio has no fallback member: when the sidecar is unconfigured,
 * down, slow or answers garbage, the student gets one friendly line
 * asking them to type instead — never a raw error, never silence.
 */
@Injectable()
export class NAtlasAsrProvider {
  private readonly logger = new Logger(NAtlasAsrProvider.name);

  constructor(@Inject(AI_CONFIG) private readonly aiConfig: AiConfig) {}

  async transcribeAudio(
    input: AiTranscriptionInput,
  ): Promise<AiTranscriptionResult> {
    const { baseUrl, timeoutMs } = this.aiConfig.transcription.natlas;
    const language = input.language ?? '';

    if (!baseUrl) {
      this.logger.warn(
        `Vernacular voice (${language}) requested but NATLAS_ASR_BASE_URL is not configured`,
      );
      throw new ServiceUnavailableException(this.unavailable(language));
    }

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

  private unavailable(language: string): string {
    const name =
      LANGUAGE_DISPLAY_NAMES[language as keyof typeof LANGUAGE_DISPLAY_NAMES] ??
      'this language';
    return (
      `Voice notes in ${name} are not available right now — ` +
      `please type your message instead.`
    );
  }
}
