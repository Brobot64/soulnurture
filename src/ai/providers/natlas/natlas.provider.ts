import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiGenerationError } from '../../ai.errors.js';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import {
  LANGUAGE_DISPLAY_NAMES,
  type SupportedLanguage,
} from '../../language/language.config.js';
import {
  UNDERSTANDING_PROMPT_VERSION,
  UNDERSTANDING_SYSTEM_PROMPT,
} from '../../language/understanding.prompt.js';
import {
  UNDERSTANDING_JSON_SCHEMA,
  validateUnderstanding,
  type MessageUnderstanding,
  type UnderstandingResult,
  type UnderstandingVia,
} from '../../language/understanding.schema.js';
import { OPENAI_CHAT_URL } from '../openai/openai.constants.js';
import { AiUsageMeterService } from '../usage-meter.service.js';
import { NatlasLlmProvider } from './natlas-llm.provider.js';

export interface UnderstandInput {
  text: string;
  language: SupportedLanguage;
}

export interface UnderstandOutcome {
  understanding: MessageUnderstanding;
  via: UnderstandingVia;
}

/**
 * Vernacular understanding lane (translation chain `n-atlas-local,openai`).
 * Local N-ATLaS (Ollama, free) is tried first whenever NATLAS_LLM_BASE_URL
 * is configured; any local failure — not configured, VPS down, invalid
 * JSON — falls back to OpenAI translation on the development/degraded
 * path. Both lanes are metered best-effort. Throws AiGenerationError only
 * when every lane fails, which the worker treats as a retryable job error.
 */
@Injectable()
export class NatlasTranslationProvider {
  private readonly logger = new Logger(NatlasTranslationProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly natlasLlm: NatlasLlmProvider,
    private readonly meter: AiUsageMeterService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private get apiKey() {
    // Secret lives only here; it never enters AiConfig, which GET /api/v1/ai/config exposes.
    return this.config.get<string>('OPENAI_API_KEY') ?? '';
  }

  async understand(input: UnderstandInput): Promise<UnderstandOutcome> {
    const systemPrompt = [
      UNDERSTANDING_SYSTEM_PROMPT,
      `Prompt version: ${UNDERSTANDING_PROMPT_VERSION}`,
      `Language: ${LANGUAGE_DISPLAY_NAMES[input.language]}`,
    ].join('\n\n');

    const failures: string[] = [];

    if (this.natlasLlm.configured) {
      try {
        const completion = await this.natlasLlm.completeJson(
          systemPrompt,
          input.text,
        );
        const understanding = validateUnderstanding(completion.raw);
        await this.meter.record('n-atlas-local', completion.usage);
        return {
          understanding: { ...understanding, lang: input.language, via: 'n-atlas-local' },
          via: 'n-atlas-local',
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`n-atlas-local: ${message}`);
        this.logger.warn(
          `N-ATLaS understanding failed; falling back to OpenAI: ${message}`,
        );
      }
    } else {
      failures.push('n-atlas-local: not configured');
    }

    try {
      const understanding = await this.understandViaOpenAi(
        systemPrompt,
        input.text,
      );
      return {
        understanding: { ...understanding, lang: input.language, via: 'openai' },
        via: 'openai',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`openai: ${message}`);
    }

    throw new AiGenerationError(
      `Vernacular understanding unavailable (${failures.join('; ')})`,
    );
  }

  private async understandViaOpenAi(
    systemPrompt: string,
    text: string,
  ): Promise<UnderstandingResult> {
    if (!this.apiKey) {
      throw new AiGenerationError(
        'OpenAI translation provider is not configured',
      );
    }
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.aiConfig.openai.model,
          max_completion_tokens:
            this.aiConfig.language.understandingMaxOutputTokens,
          response_format: {
            type: 'json_schema',
            json_schema: UNDERSTANDING_JSON_SCHEMA,
          },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
        }),
        signal: AbortSignal.timeout(
          this.aiConfig.language.understandingTimeoutMs,
        ),
      });
    } catch (error) {
      throw new AiGenerationError(
        'OpenAI translation provider is unreachable',
        { cause: error },
      );
    }

    if (!res.ok) {
      throw new AiGenerationError(
        `OpenAI translation provider rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new AiGenerationError(
        'OpenAI translation provider returned a non-JSON body',
        { cause: error },
      );
    })) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiGenerationError(
        'OpenAI translation provider returned an empty response',
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new AiGenerationError(
        'OpenAI translation response is not valid JSON',
        { cause: error },
      );
    }

    const understanding = validateUnderstanding(raw);
    await this.meter.record('openai', {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    });
    return understanding;
  }
}
