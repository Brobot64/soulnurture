import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { ResourceQueryDto } from './dto/resource-query.dto.js';
import { SaveToolboxDto } from './dto/save-toolbox.dto.js';
import { ResourcesService } from './resources.service.js';

@ApiTags('Resources / Coping Hub (contract)')
@Controller('v1/resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List approved resources' })
  @ApiEnvelopeOk(Object)
  list(@Session() session: UserSession, @Query() query: ResourceQueryDto) {
    return this.resourcesService.list(session.user.id, query);
  }

  @Get('tailored')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Tailored resources' })
  @ApiQuery({ name: 'checkInId', required: false })
  @ApiEnvelopeOk(Object)
  tailored(
    @Session() session: UserSession,
    @Query('checkInId') checkInId?: string,
  ) {
    return this.resourcesService.tailored(session.user.id, checkInId);
  }

  @Get('toolbox')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Personal toolbox' })
  @ApiEnvelopeOk(Object)
  toolbox(@Session() session: UserSession) {
    return this.resourcesService.toolbox(session.user.id);
  }

  @Post('toolbox')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Save to toolbox' })
  @ApiBody({ type: SaveToolboxDto })
  @ApiEnvelopeOk(Object)
  save(@Session() session: UserSession, @Body() body: SaveToolboxDto) {
    return this.resourcesService.saveToolbox(session.user.id, body.resourceId);
  }
}
