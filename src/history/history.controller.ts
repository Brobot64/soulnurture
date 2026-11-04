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
    summary: 'Own history-deletion requests, with their outcome',
    description: `
The student’s own asks, newest first, exactly as submitted, plus the state each
one reached: \`scheduledPurgeAt\` is when the removal runs and can still be
cancelled, \`cancelledAt\` that the student stopped it, \`purgedAt\` with
\`removedCheckIns\` / \`removedConversations\` that it happened, and \`holdReason\`
if an account that cannot sign in held the removal back rather than erased it.
`,
  })
  @ApiEnvelopeOk(Object)
  listDeletions(@Session() session: UserSession) {
    return this.deletionService.listMine(session.user.id);
  }

  @Post('deletion-requests/:requestId/cancel')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Cancel a deletion request inside its 24-hour window',
    description: `
The undo the student was promised. Works only while the window is open: once the
removal has run there is nothing to cancel, and the answer says so instead of
pretending the request can be reversed.

Atomic by construction — the cancel and the erasure race on one UPDATE, and the
one that reaches the row first wins.
`,
  })
  @ApiParam({
    name: 'requestId',
    description: 'Deletion request id (uuid)',
    example: '6f0f...',
  })
  @ApiEnvelopeOk(Object)
  cancelDeletion(
    @Session() session: UserSession,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.deletionService.cancel(session.user.id, requestId);
  }

  @Post('deletion-requests')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Ask for history to be deleted (runs after a 24-hour undo window)',
    description: `
Writes the ask, notifies the school's professionals, and schedules the removal 24
hours out. Nothing is deleted by this call, and no staff member decides: the
student owns the decision and can cancel until the window closes, after which the
removal is carried out automatically.

\`alertedAt\` in the receipt is the honest part. It is set only when someone at
the school was actually told; null means the ask is stored and scheduled but
nobody has been notified.
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
