import {
  Body,
  Controller,
  Delete,
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
import { OnboardProfessionalDto } from './dto/onboard-professional.dto.js';
import { OnboardSchoolAdminDto } from './dto/onboard-school-admin.dto.js';
import { OnboardStudentDto } from './dto/onboard-student.dto.js';
import { UpdateSchoolSettingsDto } from './dto/update-school-settings.dto.js';
import { UpdateSchoolUserDto } from './dto/update-school-user.dto.js';
import { SchoolUsersService } from './school-users.service.js';

@ApiTags('School admin — users')
@Controller('v1/schools')
@Roles('SCHOOL_ADMIN', 'PLATFORM_ADMIN')
export class SchoolUsersController {
  constructor(private readonly schoolUsers: SchoolUsersService) {}

  @Get(':id/overview')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'School dashboard counts (school admin)' })
  @ApiEnvelopeOk(Object)
  overview(@Session() session: UserSession, @Param('id') id: string) {
    return this.schoolUsers.overview(session.user.id, id);
  }

  @Get(':id/users')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'List a school’s users (school admin)',
    description:
      'Includes student/professional profile details and onboarding state (emailVerified, mustChangePassword, deactivatedAt).',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    description: 'Filter: STUDENT, SCHOOL_ADMIN, COUNSELLOR, PSYCHOLOGIST, SUPPORT_STAFF',
  })
  @ApiEnvelopeOk(Object)
  listUsers(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Query('role') role?: string,
  ) {
    return this.schoolUsers.listUsers(session.user.id, id, role);
  }

  @Post(':id/students')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Onboard a student (school admin)',
    description: `
Creates the account with the school default password (forced change at first
sign-in) and a unique student code, then emails the school-branded verification
link. The starter password is never included in the email — the school
distributes it.
`,
  })
  @ApiBody({ type: OnboardStudentDto })
  @ApiEnvelopeOk(Object)
  onboardStudent(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: OnboardStudentDto,
  ) {
    return this.schoolUsers.onboardStudent(session.user.id, id, body);
  }

  @Post(':id/professionals')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Onboard a professional (school admin)',
    description:
      'Counsellor, psychologist or support staff under the school. Same default-password + verification-email flow as students.',
  })
  @ApiBody({ type: OnboardProfessionalDto })
  @ApiEnvelopeOk(Object)
  onboardProfessional(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: OnboardProfessionalDto,
  ) {
    return this.schoolUsers.onboardProfessional(session.user.id, id, body);
  }

  @Patch(':id/users/:userId')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Update a school user (school admin)',
    description:
      'User fields (name, phone) and the matching profile fields (class label / preferred language / title / department).',
  })
  @ApiBody({ type: UpdateSchoolUserDto })
  @ApiEnvelopeOk(Object)
  updateUser(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: UpdateSchoolUserDto,
  ) {
    return this.schoolUsers.updateUser(session.user.id, id, userId, body);
  }

  @Delete(':id/users/:userId')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Deactivate a school user (school admin)',
    description: `
Soft removal: the account and its history stay, every session is revoked
immediately and the user cannot sign in (403 \`ACCOUNT_DEACTIVATED\`) until
reactivated.
`,
  })
  @ApiEnvelopeOk(Object)
  deactivateUser(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.schoolUsers.deactivateUser(session.user.id, id, userId);
  }

  @Post(':id/users/:userId/reactivate')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Reactivate a deactivated school user (school admin)' })
  @ApiEnvelopeOk(Object)
  reactivateUser(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.schoolUsers.reactivateUser(session.user.id, id, userId);
  }

  @Get(':id/settings')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'School identity panel (school admin)',
    description:
      'Read-only identity for the settings page: name, code, status, creation date and whether a default password is set.',
  })
  @ApiEnvelopeOk(Object)
  settings(@Session() session: UserSession, @Param('id') id: string) {
    return this.schoolUsers.settings(session.user.id, id);
  }

  @Get(':id/chat-threads')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Chat thread register of a school (school admin)',
    description:
      'Every thread with both participants, the lifecycle stamps and a last-message pointer, newest first.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter: PENDING, ACTIVE, CLOSED',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Default 50, max 100' })
  @ApiEnvelopeOk(Object)
  listChatThreads(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.schoolUsers.listChatThreads(session.user.id, id, status, limit);
  }

  @Post(':id/admins')
  @Roles('PLATFORM_ADMIN')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Provision a school admin (platform admin only)',
    description: `
Grants admin rights for the school to a new SCHOOL_ADMIN account using the
school default password (forced change at first sign-in) plus the branded
verification email. Deliberately owner-only: school admins cannot mint peers.
`,
  })
  @ApiBody({ type: OnboardSchoolAdminDto })
  @ApiEnvelopeOk(Object)
  onboardSchoolAdmin(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: OnboardSchoolAdminDto,
  ) {
    return this.schoolUsers.onboardSchoolAdmin(session.user.id, id, body);
  }

  @Post(':id/users/:userId/reset-password')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Reset a school user to the default password (school admin)',
    description: `
Puts the credential password back to the school default, forces the change
screen again and revokes every session. Refused for the caller's own account
and for platform admins.
`,
  })
  @ApiEnvelopeOk(Object)
  resetUserPassword(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.schoolUsers.resetUserPassword(session.user.id, id, userId);
  }

  @Patch(':id/settings')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Update school settings (school admin)',
    description: `
Sets the school-wide default password used for every account onboarded from
now on. Hashed immediately (scrypt); never returned or logged. Existing
accounts keep their personal passwords.
`,
  })
  @ApiBody({ type: UpdateSchoolSettingsDto })
  @ApiEnvelopeOk(Object)
  updateSettings(
    @Session() session: UserSession,
    @Param('id') id: string,
    @Body() body: UpdateSchoolSettingsDto,
  ) {
    return this.schoolUsers.updateSettings(session.user.id, id, body);
  }
}
