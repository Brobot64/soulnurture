import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { CreateCheckInDto } from './dto/create-check-in.dto.js';
import { CheckInsService } from './check-ins.service.js';

@ApiTags('Check-ins (contract)')
@Controller('v1/check-ins')
export class CheckInsController {
  constructor(private readonly checkInsService: CheckInsService) {}

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Create emotional check-in' })
  @ApiBody({ type: CreateCheckInDto })
  @ApiEnvelopeOk(Object)
  create(@Session() session: UserSession, @Body() body: CreateCheckInDto) {
    return this.checkInsService.create(session.user.id, body);
  }

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List own check-ins' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.checkInsService.listMine(session.user.id);
  }

  @Get(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get check-in by id' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getOne(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.checkInsService.getOne(session.user.id, id);
  }
}
