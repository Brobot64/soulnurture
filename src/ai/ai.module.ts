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
import { AI_PROVIDER } from './providers/ai-provider.interface.js';
import { GroqAiProvider } from './providers/groq/groq.provider.js';
import { AI_CONFIG, buildAiConfig } from './config/ai.config.js';
import { IntentEngineService } from './intents/intent-engine.service.js';

@Module({
  imports: [PrismaModule, AuditModule, ConsentModule, ConfigModule],
  controllers: [AiController, AiDisclosureController],
  providers: [
    AiService,
    AiContextService,
    IntentEngineService,
    AiWorkerService,
    GroqAiProvider,
    { provide: AI_PROVIDER, useExisting: GroqAiProvider },
    {
      provide: AI_CONFIG,
      useFactory: buildAiConfig,
      inject: [ConfigService],
    },
  ],
  exports: [AiService, AiWorkerService, IntentEngineService, AI_CONFIG],
})
export class AiModule {}
