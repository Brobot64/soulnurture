import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { Roles } from '../common/guards/roles.decorator.js';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { RequestHistoryDeletionDto } from './dto/request-history-deletion.dto.js';
import { HistoryDeletionService } from './history-deletion.service.js';
import { HistoryService } from './history.service.js';

@ApiTags('Student wellbeing history')
@Controller('v1/history')
@Roles('STUDENT')
export class HistoryController {
  constructor(
    private readonly historyService: HistoryService,
    private readonly deletionService: HistoryDeletionService,
  ) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Own wellbeing history',
    description: `
Newest-first timeline of the student's own check-ins, each carrying the
reflection it led to (turn count, typed vs voice, summary once closed) and the
support request it produced (status plus the same derived follow-up state the
staff queue uses). Nothing professional-only is in this response: review notes,
safeguarding flags and audit rows are never selected.

Every entry is one the student created. There is no resource link in the schema,
so no entry claims a resource was shared.
`,
  })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.historyService.list(session.user.id);
  }

  /**
   * Literal segments are declared before `:checkInId` so they win over the
   * uuid param.
   */
  @Get('deletion-requests')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Own history-deletion requests, as filed',
    description:
      'The student’s own asks, newest first, exactly as submitted. There is no outcome field: nothing in this product has yet been decided or removed, and inventing a status column would be a promise the server cannot keep.',
  })
  @ApiEnvelopeOk(Object)
  listDeletions(@Session() session: UserSession) {
    return this.deletionService.listMine(session.user.id);
  }

  @Post('deletion-requests')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Ask for history to be deleted (request only)',
    description: `
Writes the ask and notifies the school's professionals. Deletes nothing: some of
what a student shared may have to be kept for safeguarding or legal reasons, so
the decision is a person's, not this endpoint's.

\`alertedAt\` in the receipt is the honest part. It is set only when a reviewer
was actually told; null means the ask is stored but nobody at the school has
been notified, and the student is shown that rather than a review that will not
come.
`,
  })
  @ApiBody({ type: RequestHistoryDeletionDto })
  @ApiEnvelopeOk(Object)
  createDeletion(
    @Session() session: UserSession,
    @Body() body: RequestHistoryDeletionDto,
  ) {
    return this.deletionService.create(session.user.id, body);
  }

  @Get(':checkInId')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'One check-in with its reflection turns',
    description:
      'The student’s own check-in with the full message list of the reflection it led to. Another student’s id, or an id that does not exist, is a 404 — never a 403 that confirms it belongs to someone else.',
  })
  @ApiParam({ name: 'checkInId', description: 'Check-in id (uuid)', example: '6f0f...' })
  @ApiEnvelopeOk(Object)
  async detail(
    @Session() session: UserSession,
    @Param('checkInId', ParseUUIDPipe) checkInId: string,
  ) {
    const entry = await this.historyService.detail(session.user.id, checkInId);
    if (!entry) throw new NotFoundException('Check-in not found');
    return entry;
  }
}
