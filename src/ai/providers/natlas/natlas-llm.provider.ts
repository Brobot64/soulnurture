import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';

/** Thrown for every N-ATLaS failure (unconfigured, unreachable, bad
 * payload). The translation lane catches this and falls back to OpenAI. */
export class NatlasUnavailableError extends Error {
  override name = 'NatlasUnavailableError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface NatlasCompletion {
  raw: unknown;
  usage: { inputTokens?: number; outputTokens?: number };
}

/**
 * Raw client for N-ATLaS behind an OpenAI-compatible chat API — the hosted
 * Hugging Face Inference Endpoint (vLLM) in production, any OpenAI-shape
 * server (e.g. a local Ollama's `/v1` route) in dev. Deliberately NOT an
 * `AiProvider` chain member: its contract is single-shot JSON completions
 * for the vernacular lane, not the chat/reflection contract the chain
 * members implement. See natlas.provider.ts for the lane that orchestrates
 * N-ATLaS → OpenAI.
 */
@Injectable()
export class NatlasLlmProvider {
  constructor(
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    private readonly config: ConfigService,
  ) {}

  get configured(): boolean {
    return this.aiConfig.language.natlasBaseUrl !== null;
  }

  /** Secret lives only here; it never enters AiConfig, which
   * GET /api/v1/ai/config exposes. */
  private get apiKey(): string {
    return this.config.get<string>('NATLAS_LLM_API_KEY')?.trim() ?? '';
  }

  async completeJson(
    systemPrompt: string,
    userContent: string,
  ): Promise<NatlasCompletion> {
    const baseUrl = this.aiConfig.language.natlasBaseUrl;
    if (!baseUrl) {
      throw new NatlasUnavailableError('N-ATLaS endpoint is not configured');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = this.apiKey;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.aiConfig.language.natlasModel,
          stream: false,
          temperature: 0.1,
          max_tokens: this.aiConfig.language.understandingMaxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.aiConfig.language.natlasTimeoutMs),
      });
    } catch (error) {
      throw new NatlasUnavailableError('N-ATLaS endpoint is unreachable', {
        cause: error,
      });
    }

    if (!res.ok) {
      throw new NatlasUnavailableError(
        `N-ATLaS endpoint rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new NatlasUnavailableError(
        'N-ATLaS endpoint returned a non-JSON body',
        { cause: error },
      );
    })) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new NatlasUnavailableError(
        'N-ATLaS endpoint returned an empty response',
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new NatlasUnavailableError('N-ATLaS response is not valid JSON', {
        cause: error,
      });
    }

    return {
      raw,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    };
  }
}
