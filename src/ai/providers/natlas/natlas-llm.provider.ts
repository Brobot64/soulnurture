import { Inject, Injectable } from '@nestjs/common';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';

/** Thrown for every local N-ATLaS failure (unconfigured, unreachable, bad
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
 * Raw client for the locally hosted N-ATLaS model (Ollama HTTP API on the
 * Contabo VPS). Deliberately NOT an `AiProvider` chain member: its contract
 * is single-shot JSON translation, not the chat/reflection contract, and it
 * never serves synchronous turns. See natlas.provider.ts for the lane that
 * orchestrates local → OpenAI.
 */
@Injectable()
export class NatlasLlmProvider {
  constructor(@Inject(AI_CONFIG) private readonly aiConfig: AiConfig) {}

  get configured(): boolean {
    return this.aiConfig.language.natlasBaseUrl !== null;
  }

  async completeJson(
    systemPrompt: string,
    userContent: string,
  ): Promise<NatlasCompletion> {
    const baseUrl = this.aiConfig.language.natlasBaseUrl;
    if (!baseUrl) {
      throw new NatlasUnavailableError(
        'N-ATLaS local endpoint is not configured',
      );
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.aiConfig.language.natlasModel,
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(
          this.aiConfig.language.understandingTimeoutMs,
        ),
      });
    } catch (error) {
      throw new NatlasUnavailableError(
        'N-ATLaS local endpoint is unreachable',
        { cause: error },
      );
    }

    if (!res.ok) {
      throw new NatlasUnavailableError(
        `N-ATLaS local endpoint rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new NatlasUnavailableError(
        'N-ATLaS local endpoint returned a non-JSON body',
        { cause: error },
      );
    })) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const content = json.message?.content;
    if (!content) {
      throw new NatlasUnavailableError(
        'N-ATLaS local endpoint returned an empty response',
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
        inputTokens: json.prompt_eval_count,
        outputTokens: json.eval_count,
      },
    };
  }
}
