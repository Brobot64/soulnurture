import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import { ConsentModule } from '../consent/consent.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiContextService } from './context/ai-context.service.js';
import { AiDisclosureController } from './disclosure/disclosure.controller.js';
import { AiWorkerService } from './ai-worker.service.js';
import {
  AI_PROVIDER,
  type AiProvider,
} from './providers/ai-provider.interface.js';
import {
  ChainedAiProvider,
  AI_PROVIDER_CHAIN_MEMBERS,
  type ChainMember,
} from './providers/chain.provider.js';
import { GroqAiProvider } from './providers/groq/groq.provider.js';
import { OpenAiProvider } from './providers/openai/openai.provider.js';
import { EmbeddingProvider } from './providers/embedding/embedding.provider.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { AiUsageMeterService } from './providers/usage-meter.service.js';
import { AI_CONFIG, buildAiConfig } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import { GuardrailService } from './guardrails/guardrail.service.js';
import { IntentEngineService } from './intents/intent-engine.service.js';

@Module({
  imports: [PrismaModule, AuditModule, ConsentModule, ConfigModule],
  controllers: [AiController, AiDisclosureController],
  providers: [
    AiService,
    AiContextService,
    IntentEngineService,
    AiWorkerService,
    GuardrailService,
    GroqAiProvider,
    OpenAiProvider,
    EmbeddingProvider,
    MemoryRepository,
    AiUsageMeterService,
    {
      provide: AI_PROVIDER_CHAIN_MEMBERS,
      useFactory: (
        aiConfig: AiConfig,
        openai: OpenAiProvider,
        groq: GroqAiProvider,
      ): ChainMember[] => {
        // Registry of chainable members — 'n-atlas' joins here in Phase C
        // step 4. Unknown names fail fast at boot, not mid-conversation.
        const registry: Record<string, AiProvider> = {
          openai,
          groq,
        };
        const members = aiConfig.chain.order.map((name) => {
          const provider = registry[name];
          if (!provider) {
            throw new Error(
              `Unknown AI provider "${name}" in AI_PROVIDER_CHAIN ` +
                `(known: ${Object.keys(registry).join(', ')})`,
            );
          }
          return { name, provider };
        });
        if (members.length === 0) {
          throw new Error('AI_PROVIDER_CHAIN resolved to zero providers');
        }
        return members;
      },
      inject: [AI_CONFIG, OpenAiProvider, GroqAiProvider],
    },
    ChainedAiProvider,
    { provide: AI_PROVIDER, useExisting: ChainedAiProvider },
    {
      provide: AI_CONFIG,
      useFactory: buildAiConfig,
      inject: [ConfigService],
    },
  ],
  exports: [
    AiService,
    AiWorkerService,
    IntentEngineService,
    GuardrailService,
    AI_CONFIG,
  ],
})
export class AiModule {}
