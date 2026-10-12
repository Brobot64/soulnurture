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
  validateUnderstanding,
  type MessageUnderstanding,
  type UnderstandingVia,
} from '../../language/understanding.schema.js';
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
 * Translation lane — N-ATLaS ONLY. N-ATLaS translates the student's message
 * into English; OpenAI never translates. The reply is drafted by OpenAI from
 * that English, and N-ATLaS renders it back (see ai.service.ts).
 *
 * The call has a short deadline (natlasTranslateTimeoutMs). Any failure — not
 * configured, unreachable, a cold endpoint past the deadline, or an invalid
 * payload — throws AiGenerationError. The caller then drafts from the original
 * message and records that in the reply's notes, and the second safety pass
 * retries the translation later.
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

  async understand(input: UnderstandInput): Promise<UnderstandOutcome> {
    if (!this.natlasLlm.configured) {
      throw new AiGenerationError(
        'Translation unavailable (N-ATLaS: not configured)',
      );
    }

    const systemPrompt = [
      UNDERSTANDING_SYSTEM_PROMPT,
      `Prompt version: ${UNDERSTANDING_PROMPT_VERSION}`,
      `Language: ${LANGUAGE_DISPLAY_NAMES[input.language]}`,
    ].join('\n\n');

    try {
      const completion = await this.natlasLlm.completeJson(
        systemPrompt,
        input.text,
        this.aiConfig.language.natlasTranslateTimeoutMs,
      );
      const understanding = validateUnderstanding(completion.raw);
      await this.meter.record('n-atlas-local', completion.usage);
      return {
        understanding: { ...understanding, lang: input.language, via: 'n-atlas-local' },
        via: 'n-atlas-local',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`N-ATLaS translation unavailable: ${message}`);
      throw new AiGenerationError(
        `Translation unavailable (N-ATLaS: ${message})`,
        { cause: error },
      );
    }
  }
}
