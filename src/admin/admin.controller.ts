import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { EraseUserDto } from '../common/dto/erase-user.dto.js';
import { AdminService } from './admin.service.js';
import { UserErasureService } from './user-erasure.service.js';

@ApiTags('Platform admin — overview')
@Controller('v1/admin')
@Roles('PLATFORM_ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly userErasure: UserErasureService,
  ) {}

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

  @Post('users/:userId/erase')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Delete any user entirely (platform admin)',
    description: `
Removes the account and everything the system holds about it: sessions, the
credential, the student's whole wellbeing history or the staff profile, the
audit rows that name them, other people's notifications quoting them, queued AI
jobs holding their ids, and Better Auth's verification links. Copies a foreign
key cannot reach are swept too, so the person reads as never having existed.

Irreversible and outside the student's 24-hour undo window — that window
protects a request the student filed themselves. The action is recorded in the
school's audit trail with the acting admin, and nothing else about the person
survives. Refused for the caller's own account and for the last platform admin.
`,
  })
  @ApiBody({ type: EraseUserDto })
  @ApiEnvelopeOk(Object)
  eraseUser(
    @Session() session: UserSession,
    @Param('userId') userId: string,
    @Body() body: EraseUserDto,
  ) {
    return this.userErasure.erase(session.user.id, userId, null, body.confirm);
  }

  @Post('users/:userId/resend-verification')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Send the verification email again (platform admin)',
    description: `
For an account that has not verified its email yet. An already-verified account
answers \`sent: false, alreadyVerified: true\` rather than mailing a second
link. A failed send is reported, not thrown: the admin can retry, and the
account is untouched either way.
`,
  })
  @ApiEnvelopeOk(Object)
  resendVerification(
    @Session() session: UserSession,
    @Param('userId') userId: string,
  ) {
    return this.userErasure.resendVerificationEmail(session.user.id, userId, null);
  }
}
