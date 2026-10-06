import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { AiService } from './ai.service.js';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_SEVERITIES,
  CANONICAL_TOPICS,
  INTENTS,
} from './intents/intents.config.js';

const ALLOWED = new Set([
  'audio/webm',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/ogg',
  'video/webm',
]);

@ApiTags('Conversations & AI (contract)')
@Controller('v1/ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  @Get('config')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Explain current AI configuration and safeguarding intents',
    description:
      'Non-secret explanation surface for professionals and the clinical reviewer: chat/transcription/embedding models, session-summary memory settings (idle close, recall windows), context bounds, async pipeline settings, the guardrail configuration (input/output/rate), and every registered intent with its detection signals and actions. Secrets (API keys) are never included.',
  })
  @ApiEnvelopeOk(Object)
  config() {
    return {
      promptVersion: this.aiConfig.promptVersion,
      chain: this.aiConfig.chain,
      chat: this.aiConfig.chat,
      openai: this.aiConfig.openai,
      pricing: this.aiConfig.pricing,
      budget: this.aiConfig.budget,
      transcription: this.aiConfig.transcription,
      embedding: this.aiConfig.embedding,
      memory: this.aiConfig.memory,
      summaries: this.aiConfig.summaries,
      context: this.aiConfig.context,
      async: this.aiConfig.async,
      safeguarding: this.aiConfig.safeguarding,
      guardrails: this.aiConfig.guardrails,
      intents: INTENTS.map((intent) => ({
        id: intent.id,
        label: intent.label,
        description: intent.description,
        severity: intent.severity,
        keywords: intent.serverSignals.keywords,
        aiCategories: intent.serverSignals.aiCategories,
        actions: intent.actions.map((action) => action.type),
      })),
      canonicalCategories: CANONICAL_CATEGORIES,
      canonicalSeverities: CANONICAL_SEVERITIES,
      canonicalTopics: CANONICAL_TOPICS,
    };
  }

  @Post('transcribe')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Transcribe voice input' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['audio'],
      properties: {
        audio: { type: 'string', format: 'binary' },
        language: { type: 'string' },
      },
    },
  })
  @ApiEnvelopeOk(Object)
  async transcribe(@Req() req: FastifyRequest) {
    if (!req.isMultipart?.()) {
      throw new BadRequestException('Expected multipart form data');
    }
    const data = await req.file();
    if (!data || data.fieldname !== 'audio') {
      throw new BadRequestException('audio file is required');
    }
    if (!ALLOWED.has(data.mimetype)) {
      throw new BadRequestException(`Unsupported audio type: ${data.mimetype}`);
    }
    const buffer = await data.toBuffer();
    if (buffer.byteLength > 10 * 1024 * 1024) {
      throw new BadRequestException('Audio file too large (max 10MB)');
    }
    return this.aiService.transcribe({
      buffer,
      filename: data.filename || 'audio.webm',
      mimeType: data.mimetype,
    });
  }
}
