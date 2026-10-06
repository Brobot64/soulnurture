import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { CreateJournalDto } from './dto/create-journal.dto.js';
import { UpdateJournalDto } from './dto/update-journal.dto.js';
import { JournalService } from './journal.service.js';

@ApiTags('Journal (contract)')
@Controller('v1/journal')
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List journal entries' })
  @ApiEnvelopeOkArray(Object)
  list(@Session() session: UserSession) {
    return this.journalService.listMine(session.user.id);
  }

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Create journal entry' })
  @ApiBody({ type: CreateJournalDto })
  @ApiEnvelopeOk(Object)
  create(@Session() session: UserSession, @Body() body: CreateJournalDto) {
    return this.journalService.create(session.user.id, body);
  }

  @Get(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get journal entry' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getOne(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.journalService.getOne(session.user.id, id);
  }

  @Patch(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Update journal entry' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateJournalDto })
  @ApiEnvelopeOk(Object)
  update(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateJournalDto,
  ) {
    return this.journalService.update(session.user.id, id, body);
  }

  @Delete(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Delete journal entry' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  delete(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.journalService.delete(session.user.id, id);
  }
}