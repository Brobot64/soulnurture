import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import { OPENAI_EMBEDDINGS_URL } from './embedding.constants.js';

/** Thrown for every embedding failure (no key, network, bad payload). Callers
 * in the memory layer catch this and degrade to recency-only recall. */
export class EmbeddingUnavailableError extends Error {
  override name = 'EmbeddingUnavailableError';

  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

@Injectable()
export class EmbeddingProvider {
  constructor(
    private readonly config: ConfigService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private get apiKey() {
    // Secret lives only here; it never enters AiConfig, which GET /api/v1/ai/config exposes.
    return this.config.get<string>('OPENAI_API_KEY') ?? '';
  }

  /** Returns a 1536-dimension vector for the text. Throws EmbeddingUnavailableError. */
  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new EmbeddingUnavailableError('OpenAI embeddings are not configured');
    }
    if (!text.trim()) {
      throw new EmbeddingUnavailableError('Cannot embed empty text');
    }

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.aiConfig.embedding.model,
          input: text,
        }),
        signal: AbortSignal.timeout(this.aiConfig.embedding.timeoutMs),
      });
    } catch (error) {
      throw new EmbeddingUnavailableError('OpenAI embeddings are unreachable', {
        cause: error,
      });
    }

    if (!res.ok) {
      throw new EmbeddingUnavailableError(
        `OpenAI embeddings rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new EmbeddingUnavailableError(
        'OpenAI embeddings returned a non-JSON body',
        { cause: error },
      );
    })) as { data?: { embedding?: unknown }[] };

    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new EmbeddingUnavailableError(
        'OpenAI embeddings returned no vector',
      );
    }
    return vector as number[];
  }
}
