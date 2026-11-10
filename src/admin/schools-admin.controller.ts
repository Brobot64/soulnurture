import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { AdminService } from './admin.service.js';
import { CreateSchoolDto } from './dto/create-school.dto.js';
import { RenameSchoolDto } from './dto/rename-school.dto.js';

@ApiTags('Platform admin — schools')
@Controller('v1/schools')
@Roles('PLATFORM_ADMIN')
export class SchoolsAdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Onboard a school (platform admin)',
    description: `
Creates an ACTIVE school with a generated 6-character short code. The optional
\`defaultPassword\` is hashed immediately (scrypt) and stored on the school —
never returned, never logged. Every account the school later onboards signs in
with it once and is forced to set a personal password.
`,
  })
  @ApiBody({ type: CreateSchoolDto })
  @ApiEnvelopeOk(Object)
  createSchool(@Session() session: UserSession, @Body() body: CreateSchoolDto) {
    return this.adminService.createSchool(session.user.id, body);
  }

  @Get()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'List schools with live gauges (platform admin)',
    description:
      'Each school carries user counts, students, professionals, pending chat requests and lastActivityAt (newest session per school, null if never). Newest first, `take` per page, `before` walks back.',
  })
  @ApiQuery({
    name: 'take',
    required: false,
    description: 'Schools per page (default 25, max 100)',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'Cursor: pass page.nextBefore to read the older pages',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Match on school name or short code',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'ACTIVE or SUSPENDED',
  })
  @ApiEnvelopeOk(Object)
  listSchools(
    @Query('take') take?: string,
    @Query('before') before?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.listSchools(take, before, { q, status });
  }

  @Patch(':id')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Rename a school (platform admin)' })
  @ApiBody({ type: RenameSchoolDto })
  @ApiEnvelopeOk(Object)
  rename(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: RenameSchoolDto,
  ) {
    return this.adminService.renameSchool(session.user.id, id, body.name);
  }

  @Post(':id/suspend')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Suspend a school (platform admin)',
    description: `
Every account under the school loses live sessions immediately and cannot
sign in again (403 \`SCHOOL_SUSPENDED\`) until reactivation. Each affected user
also receives a durable in-app notification explaining the suspension.
`,
  })
  @ApiEnvelopeOk(Object)
  suspend(@Session() session: UserSession, @Param('id') id: string) {
    return this.adminService.suspendSchool(session.user.id, id);
  }

  @Post(':id/reactivate')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Reactivate a suspended school (platform admin)' })
  @ApiEnvelopeOk(Object)
  reactivate(@Session() session: UserSession, @Param('id') id: string) {
    return this.adminService.reactivateSchool(session.user.id, id);
  }
}
