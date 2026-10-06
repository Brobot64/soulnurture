import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { FastifyRequest } from 'fastify';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { StudentsService } from '../students/students.service.js';
import { AiService } from './ai.service.js';
import { AI_CONFIG } from './config/ai.config.js';
import type { AiConfig } from './config/ai.config.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_SEVERITIES,
  CANONICAL_TOPICS,
  INTENTS,
} from './intents/intents.config.js';
import {
  VERNACULAR_KEYWORDS,
  VERNACULAR_KEYWORD_REVIEW_STATUS,
} from './intents/vernacular-keywords.js';

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
    private readonly studentsService: StudentsService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  @Get('config')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Explain current AI configuration and safeguarding intents',
    description:
      'Non-secret explanation surface for professionals and the clinical reviewer: chat/transcription/embedding models, session-summary memory settings (idle close, recall windows), context bounds, async pipeline settings, the guardrail configuration (input/output/rate), the language layer (supported languages, reply mode, detection-driven offer), every registered intent with its detection signals and actions, and the vernacular keyword packs with their clinical-review status. Secrets (API keys) are never included.',
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
      language: this.aiConfig.language,
      intents: INTENTS.map((intent) => ({
        id: intent.id,
        label: intent.label,
        description: intent.description,
        severity: intent.severity,
        keywords: intent.serverSignals.keywords,
        aiCategories: intent.serverSignals.aiCategories,
        actions: intent.actions.map((action) => action.type),
      })),
      vernacularKeywords: VERNACULAR_KEYWORDS,
      vernacularReviewStatus: VERNACULAR_KEYWORD_REVIEW_STATUS,
      canonicalCategories: CANONICAL_CATEGORIES,
      canonicalSeverities: CANONICAL_SEVERITIES,
      canonicalTopics: CANONICAL_TOPICS,
    };
  }

  @Post('transcribe')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Transcribe voice input',
    description:
      'Routes by language: English and Nigerian Pidgin go to the Whisper chain (Pidgin auto-detected); Yoruba, Hausa and Igbo go to the local N-ATLaS ASR sidecar. The optional `language` field forces the route for this request; it defaults to the student profile preferredLanguage. When the vernacular sidecar is unavailable the response is a friendly 503 asking the student to type instead.',
  })
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
  async transcribe(
    @Session() session: UserSession,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart?.()) {
      throw new BadRequestException('Expected multipart form data');
    }

    // req.parts() is consumed in order: fields and files arrive interleaved,
    // so `data.fields` after req.file() can miss a trailing `language` field.
    let audio: { buffer: Buffer; filename: string; mimeType: string } | null =
      null;
    let language: string | undefined;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio') {
          part.file.resume();
          continue;
        }
        if (!ALLOWED.has(part.mimetype)) {
          throw new BadRequestException(
            `Unsupported audio type: ${part.mimetype}`,
          );
        }
        const buffer = await part.toBuffer();
        if (buffer.byteLength > 10 * 1024 * 1024) {
          throw new BadRequestException('Audio file too large (max 10MB)');
        }
        audio = {
          buffer,
          filename: part.filename || 'audio.webm',
          mimeType: part.mimetype,
        };
        continue;
      }
      if (part.fieldname === 'language' && typeof part.value === 'string') {
        language = part.value;
      }
    }

    if (!audio) {
      throw new BadRequestException('audio file is required');
    }

    const student = await this.studentsService.ensureProfile(session.user.id);
    return this.aiService.transcribe({
      ...audio,
      language,
      preferredLanguage: student.preferredLanguage,
    });
  }
}
