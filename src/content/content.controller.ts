import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ContentKind, ContentStatus } from '@prisma/client';
import {
  ApiEnvelopeOkArray,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { ContentService } from './content.service.js';

/**
 * The content register as an admin-facing table (Doc C §6/§7): code, version,
 * status, approver, effective dates. Reads only — flipping a row's
 * status/effectiveTo (the rollback drill) is a reviewed administrative action,
 * not an unguarded HTTP write. The student/staff surfaces consume content
 * through ContentService.resolve, never through this endpoint.
 */
@ApiTags('Content registry (contract)')
@Controller('v1/content')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  @Roles('PLATFORM_ADMIN')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List the content register (admin)' })
  @ApiQuery({ name: 'kind', required: false, enum: ContentKind })
  @ApiQuery({ name: 'status', required: false, enum: ContentStatus })
  @ApiQuery({ name: 'locale', required: false })
  @ApiEnvelopeOkArray(Object)
  list(
    @Query('kind') kind?: ContentKind,
    @Query('status') status?: ContentStatus,
    @Query('locale') locale?: string,
  ) {
    return this.contentService.list({ kind, status, locale });
  }
}
