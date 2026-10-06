import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiGenerationError } from '../../ai.errors.js';
import type {
  AiGenerationInput,
  AiGenerationResult,
  AiProvider,
  AiTranscriptionInput,
  AiTranscriptionResult,
} from '../ai-provider.interface.js';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import { GROQ_CHAT_URL, GROQ_TRANSCRIBE_URL } from './groq.constants.js';

@Injectable()
export class GroqAiProvider implements AiProvider {
  constructor(
    private readonly config: ConfigService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private get apiKey() {
    // Secret lives only here; it never enters AiConfig, which GET /api/v1/ai/config exposes.
    return this.config.get<string>('GROQ_API_KEY') ?? '';
  }

  async generateResponse(
    input: AiGenerationInput,
  ): Promise<AiGenerationResult> {
    if (!this.apiKey) {
      // No key configured: a deterministic, warm reflection so the journey
      // still works. Callers treat this as a normal, COMPLETE result.
      return {
        message:
          'Thank you for sharing. Take a gentle breath. What feels most present for you right now?',
        emotion: { detected: null, confidence: null },
        reflection: {
          question: 'What feels most present for you right now?',
          insight: null,
        },
        resource: { recommended: false, resourceId: null },
        humanSupport: { recommended: false, type: null, reason: null },
        supportFlag: { candidate: false, category: null, severity: null },
        action: 'REFLECTION',
      };
    }

    const { model, maxOutputTokens, temperature, attemptTimeoutMs } =
      this.aiConfig.chat;
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.systemPrompt },
            ...input.messages,
          ],
        }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
    } catch (error) {
      throw new AiGenerationError('AI provider is unreachable', {
        cause: error,
      });
    }

    if (!res.ok) {
      throw new AiGenerationError(
        `AI provider rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new AiGenerationError('AI provider returned a non-JSON body', {
        cause: error,
      });
    })) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiGenerationError('AI provider returned an empty response');
    }

    let parsed: AiGenerationResult;
    try {
      parsed = JSON.parse(content) as AiGenerationResult;
    } catch (error) {
      throw new AiGenerationError('AI response is not valid JSON', {
        cause: error,
      });
    }

    return {
      ...parsed,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      },
    };
  }

  async transcribeAudio(
    input: AiTranscriptionInput,
  ): Promise<AiTranscriptionResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Transcription provider unavailable',
      );
    }
    const model = this.aiConfig.transcription.model;
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.filename,
    );
    form.append('model', model);
    if (input.language) form.append('language', input.language);

    let res: Response;
    try {
      res = await fetch(GROQ_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.aiConfig.chat.attemptTimeoutMs * 3),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Transcription provider unreachable',
      );
    }
    if (!res.ok) throw new ServiceUnavailableException('Transcription failed');
    const json = (await res.json()) as { text?: string };
    return { text: json.text ?? '' };
  }
}
