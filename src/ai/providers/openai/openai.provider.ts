import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AiGenerationError } from '../../ai.errors.js';
import { AiGenerationResultSchema } from '../../schemas/ai-response.schema.js';
import { AI_CONFIG } from '../../config/ai.config.js';
import type { AiConfig } from '../../config/ai.config.js';
import type {
  AiGenerationInput,
  AiGenerationResult,
  AiProvider,
  AiTranscriptionInput,
  AiTranscriptionResult,
} from '../ai-provider.interface.js';
import { OPENAI_CHAT_URL } from './openai.constants.js';

// Structured-output contract: built from the Zod schema minus server-owned
// keys (usage) — the model may only ever produce the validated shape.
const RESPONSE_JSON_SCHEMA = {
  name: 'ai_generation_result',
  strict: true,
  schema: zodToJsonSchema(AiGenerationResultSchema.omit({ usage: true }), {
    $refStrategy: 'none',
  }),
} as const;

@Injectable()
export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly config: ConfigService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private get apiKey() {
    // Secret lives only here; it never enters AiConfig, which GET /api/v1/ai/config exposes.
    return this.config.get<string>('OPENAI_API_KEY') ?? '';
  }

  async generateResponse(
    input: AiGenerationInput,
  ): Promise<AiGenerationResult> {
    if (!this.apiKey) {
      // Chain discipline: a key-less member is a failed attempt, not a stub —
      // the chain must fall through to the next member in declared order.
      throw new AiGenerationError('OpenAI provider is not configured');
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
        body: JSON.stringify(this.buildChatBody(input)),
        signal: AbortSignal.timeout(this.aiConfig.chat.attemptTimeoutMs),
      });
    } catch (error) {
      throw new AiGenerationError('OpenAI provider is unreachable', {
        cause: error,
      });
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new AiGenerationError(
        `OpenAI provider rejected the request with status ${res.status}: ${detail}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new AiGenerationError('OpenAI provider returned a non-JSON body', {
        cause: error,
      });
    })) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiGenerationError('OpenAI provider returned an empty response');
    }

    let parsed: AiGenerationResult;
    try {
      parsed = JSON.parse(content) as AiGenerationResult;
    } catch (error) {
      throw new AiGenerationError('OpenAI response is not valid JSON', {
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
    _input: AiTranscriptionInput,
  ): Promise<AiTranscriptionResult> {
    // Voice is routed by the chain: English → Groq Whisper, vernacular →
    // N-ATLaS ASR sidecar (Phase C step 5). OpenAI offers no transcription
    // here, so the chain skips this member for audio.
    throw new ServiceUnavailableException(
      'OpenAI transcription is not offered in this chain',
    );
  }

  private buildChatBody(input: AiGenerationInput) {
    // Reasoning models may reject temperature — send it only when explicitly
    // configured (OPENAI_TEMPERATURE), never by default.
    const temperature = this.config.get<string>('OPENAI_TEMPERATURE');
    return {
      model: this.aiConfig.openai.model,
      max_completion_tokens: this.aiConfig.openai.maxOutputTokens,
      ...(temperature !== undefined && temperature !== ''
        ? { temperature: Number(temperature) }
        : {}),
      response_format: {
        type: 'json_schema',
        json_schema: input.jsonSchema ?? RESPONSE_JSON_SCHEMA,
      },
      messages: [
        { role: 'system', content: input.systemPrompt },
        ...input.messages,
      ],
    };
  }
}
