import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { NatlasEndpointsService } from './providers/natlas/natlas-endpoints.service.js';

/**
 * The owner's view of the hosted inference endpoints. Separate from
 * AdminController because the service it drives lives in this module — the
 * URLs and their tokens come from AI_CONFIG and ConfigService, and importing
 * AiModule into AdminModule would close a cycle through StudentsModule.
 */
@ApiTags('Platform admin — inference endpoints')
@Controller('v1/admin/ai')
@Roles('PLATFORM_ADMIN')
export class AiAdminController {
  constructor(
    private readonly endpoints: NatlasEndpointsService,
    private readonly audit: AuditService,
  ) {}

  @Get('endpoints')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'List the hosted inference endpoints (platform admin)',
    description: `
What the vernacular lanes are configured to run on: the three NCAIR1 whisper
fine-tunes behind \`NATLAS_ASR_URL_YO|HA|IG\` and the N-ATLaS chat endpoint
behind \`NATLAS_LLM_BASE_URL\`, each with the model it serves and whether a URL
is set at all.

Answers from configuration alone. Nothing is contacted, so this cannot say
whether a replica is running — and it deliberately does not try to: the
endpoints scale to zero and every request that reaches them starts paid GPU,
which is a decision for \`POST /endpoints/wake\`, not for opening a page.
`,
  })
  @ApiEnvelopeOkArray(Object)
  list() {
    return this.endpoints.describe();
  }

  @Post('endpoints/wake')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Start every hosted inference endpoint (platform admin)',
    description: `
Asks each endpoint for a replica. A scaled-to-zero endpoint answers this with
503 and starts loading — 2.5-3.5 minutes measured for the whisper fine-tunes,
longer for the N-ATLaS L4 — so this returns immediately with what each endpoint
said rather than waiting for any of them to come up.

Waking is what starts billing on hardware that then idles back to zero, so it is
recorded in the audit trail with the acting admin and the state each endpoint
reported. Endpoint URLs and their tokens are never returned or audited.
`,
  })
  @ApiEnvelopeOkArray(Object)
  async wake(@Session() session: UserSession) {
    const statuses = await this.endpoints.probeAll();
    await this.audit.log({
      actorId: session.user.id,
      action: 'ai.endpoints_woken',
      entity: 'AiEndpoint',
      meta: {
        endpoints: statuses.map(({ id, state, httpStatus }) => ({
          id,
          state,
          httpStatus,
        })),
      },
    });
    return statuses;
  }
}
