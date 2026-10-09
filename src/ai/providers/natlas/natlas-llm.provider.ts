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

export interface NatlasTextCompletion {
  text: string;
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
    const { content, usage } = await this.postChat(
      {
        stream: false,
        temperature: 0.1,
        max_tokens: this.aiConfig.language.understandingMaxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      this.aiConfig.language.natlasTimeoutMs,
    );

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new NatlasUnavailableError('N-ATLaS response is not valid JSON', {
        cause: error,
      });
    }

    return { raw, usage };
  }

  /** Free-text completion for the reply-render lane (no response_format —
   * the model returns the rendered message itself). Own, shorter timeout:
   * unlike the async understanding lane, the student waits on this, so a
   * cold endpoint must fail fast into the fallback chain. */
  async completeText(
    systemPrompt: string,
    userContent: string,
  ): Promise<NatlasTextCompletion> {
    const { content, usage } = await this.postChat(
      {
        stream: false,
        temperature: 0.2,
        max_tokens: this.aiConfig.language.renderMaxOutputTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      this.aiConfig.language.natlasRenderTimeoutMs,
    );
    const text = content.trim();
    if (text.length === 0) {
      throw new NatlasUnavailableError(
        'N-ATLaS endpoint returned an empty response',
      );
    }
    return { text, usage };
  }

  private async postChat(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{
    content: string;
    usage: { inputTokens?: number; outputTokens?: number };
  }> {
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
          ...body,
        }),
        signal: AbortSignal.timeout(timeoutMs),
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

    return {
      content,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    };
  }
}
