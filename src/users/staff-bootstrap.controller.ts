import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { UsersService } from './users.service.js';
import { StaffBootstrapDto } from './dto/staff-bootstrap.dto.js';

@ApiTags('Staff enrolment')
@Controller('v1/staff')
export class StaffBootstrapController {
  constructor(private readonly usersService: UsersService) {}

  @Post('bootstrap')
  @AllowAnonymous()
  @ApiStandardErrors()
  @ApiOperation({
    summary:
      'Enrol a professional account with the shared enrolment key (first-staff bootstrap)',
    description:
      'Public sign-up always creates STUDENT accounts. Professional roles are created here using the STAFF_BOOTSTRAP_KEY secret, or by an existing staff member via POST /api/v1/users. The account requires email verification before sign-in.',
  })
  @ApiBody({ type: StaffBootstrapDto })
  @ApiEnvelopeOk(Object)
  bootstrap(@Body() body: StaffBootstrapDto) {
    return this.usersService.bootstrapStaff(body);
  }
}
