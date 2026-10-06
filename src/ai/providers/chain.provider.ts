import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { AiGenerationError } from '../ai.errors.js';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import type {
  AiGenerationInput,
  AiGenerationResult,
  AiProvider,
  AiTranscriptionInput,
  AiTranscriptionResult,
} from './ai-provider.interface.js';
import { AiUsageMeterService } from './usage-meter.service.js';

export const AI_PROVIDER_CHAIN_MEMBERS = Symbol('AI_PROVIDER_CHAIN_MEMBERS');

/** One chain link: a registered provider under its config/usage name. */
export interface ChainMember {
  name: string;
  provider: AiProvider;
}

/**
 * Ordered fail-over chain for chat generation: try each member in declared
 * order (env AI_PROVIDER_CHAIN), fall through on AiGenerationError, throw
 * only when every member failed — the caller's async queue then takes over.
 *
 * Side effects per served generation: usage counters (AiUsageDaily) and the
 * serving provider stamped on usage.provider (explainability). Neither may
 * ever break the student's conversation, so both fail open.
 */
@Injectable()
export class ChainedAiProvider implements AiProvider {
  private readonly logger = new Logger(ChainedAiProvider.name);

  constructor(
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    @Inject(AI_PROVIDER_CHAIN_MEMBERS) private readonly members: ChainMember[],
    private readonly meter: AiUsageMeterService,
    private readonly audit: AuditService,
  ) {}

  async generateResponse(
    input: AiGenerationInput,
  ): Promise<AiGenerationResult> {
    const members = await this.eligibleMembers();
    let lastError: AiGenerationError | undefined;

    for (const member of members) {
      try {
        const result = await member.provider.generateResponse(input);
        const requestCount = await this.meter.record(member.name, result.usage);
        result.usage = { ...result.usage, provider: member.name };
        if (member.name === 'openai') {
          await this.auditBudgetPause(requestCount);
        }
        return result;
      } catch (error) {
        if (error instanceof AiGenerationError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw new AiGenerationError('All AI providers exhausted', {
      cause: lastError,
    });
  }

  async transcribeAudio(
    input: AiTranscriptionInput,
  ): Promise<AiTranscriptionResult> {
    // Audio routes by capability, not budget: members that do not transcribe
    // opt out with ServiceUnavailableException and the chain moves on.
    for (const member of this.members) {
      try {
        return await member.provider.transcribeAudio(input);
      } catch (error) {
        if (error instanceof ServiceUnavailableException) continue;
        throw error;
      }
    }
    throw new ServiceUnavailableException(
      'No transcription provider available in the AI chain',
    );
  }

  /**
   * Members eligible for this request. When the OpenAI daily cap is crossed,
   * OpenAI is filtered out for the rest of the server-local day and the chain
   * effectively starts at the next member.
   */
  private async eligibleMembers(): Promise<ChainMember[]> {
    const cap = this.aiConfig.budget.openaiDailyRequestCap;
    if (cap <= 0 || !this.members.some((m) => m.name === 'openai')) {
      return this.members;
    }
    const used = await this.meter.countFor('openai');
    if (used !== null && used >= cap) {
      return this.members.filter((m) => m.name !== 'openai');
    }
    return this.members;
  }

  /**
   * Fires exactly once per day: only the generation whose post-write count
   * equals the cap has crossed the line (the next one sees cap + 1).
   */
  private async auditBudgetPause(openaiCount: number | null) {
    const cap = this.aiConfig.budget.openaiDailyRequestCap;
    if (openaiCount === null || openaiCount !== cap) return;
    try {
      await this.audit.log({
        action: 'ai_budget.paused',
        entity: 'ai_usage_daily',
        meta: { provider: 'openai', dailyRequestCap: cap, requests: openaiCount },
      });
    } catch (error) {
      this.logger.warn('Budget-pause audit failed; continuing', error);
    }
  }
}
