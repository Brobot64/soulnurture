import {
  Body,
  Controller,
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
import { Roles } from '../common/guards/roles.decorator.js';
import { CreateSupportRequestDto } from './dto/create-support-request.dto.js';
import { ReviewSupportRequestDto } from './dto/review-support-request.dto.js';
import { SupportRequestsService } from './support-requests.service.js';

@ApiTags('Support Requests (contract)')
@Controller('v1/support-requests')
export class SupportRequestsController {
  constructor(
    private readonly supportRequestsService: SupportRequestsService,
  ) {}

  @Get('people')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List trusted support people' })
  @ApiEnvelopeOkArray(Object)
  people() {
    return this.supportRequestsService.listPeople();
  }

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Create support request' })
  @ApiBody({ type: CreateSupportRequestDto })
  @ApiEnvelopeOk(Object)
  create(
    @Session() session: UserSession,
    @Body() body: CreateSupportRequestDto,
  ) {
    return this.supportRequestsService.create(session.user.id, body);
  }

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List own support requests' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession) {
    return this.supportRequestsService.listMine(session.user.id);
  }

  @Get(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get support request' })
  @ApiParam({ name: 'id' })
  @ApiEnvelopeOk(Object)
  getOne(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supportRequestsService.getOne(session.user.id, id);
  }

  @Patch(':id')
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Professional review: set status plus review note',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: ReviewSupportRequestDto })
  @ApiEnvelopeOk(Object)
  review(
    @Session() session: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewSupportRequestDto,
  ) {
    return this.supportRequestsService.review(session.user.id, id, body);
  }
}
