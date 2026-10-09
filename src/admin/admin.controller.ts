import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { AdminService } from './admin.service.js';

@ApiTags('Platform admin — overview')
@Controller('v1/admin')
@Roles('PLATFORM_ADMIN')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('overview')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Platform-wide statistics (platform admin)',
    description:
      'School, user and chat counts for the owner dashboard. All counts are computed in parallel.',
  })
  @ApiEnvelopeOk(Object)
  overview() {
    return this.adminService.overview();
  }

  @Get('users')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'List users across all schools (platform admin)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  @ApiEnvelopeOk(Object)
  listUsers(@Query('limit') limit?: string) {
    return this.adminService.listUsers(limit);
  }
}
