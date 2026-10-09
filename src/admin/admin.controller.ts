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
  @ApiOperation({
    summary: 'List users across all schools (platform admin)',
    description:
      'Filterable register with a total for paging. `q` matches name or email, case-insensitively.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  @ApiQuery({ name: 'offset', required: false, description: 'Default 0' })
  @ApiQuery({
    name: 'role',
    required: false,
    description: 'STUDENT, SCHOOL_ADMIN, PLATFORM_ADMIN, COUNSELLOR, PSYCHOLOGIST, SUPPORT_STAFF',
  })
  @ApiQuery({ name: 'schoolId', required: false, description: 'Filter by school uuid' })
  @ApiQuery({ name: 'q', required: false, description: 'Name or email contains' })
  @ApiEnvelopeOk(Object)
  listUsers(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('role') role?: string,
    @Query('schoolId') schoolId?: string,
    @Query('q') q?: string,
  ) {
    return this.adminService.listUsers({ limit, offset, role, schoolId, q });
  }
}
