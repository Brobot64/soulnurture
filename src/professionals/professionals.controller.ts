import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { ProfessionalsService } from './professionals.service.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { UpdateProfessionalDto } from './dto/update-professional.dto.js';

@ApiTags('Counsellor Dashboard (contract)')
@Controller('v1/professionals')
@Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
export class ProfessionalsController {
  constructor(private readonly professionalsService: ProfessionalsService) {}

  @Get('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get professional profile' })
  @ApiEnvelopeOk(Object)
  me(@Session() session: UserSession) {
    return this.professionalsService.getMe(session.user.id);
  }

  @Patch('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Update professional profile' })
  @ApiBody({ type: UpdateProfessionalDto })
  @ApiEnvelopeOk(Object)
  updateMe(@Session() session: UserSession, @Body() body: UpdateProfessionalDto) {
    return this.professionalsService.updateMe(session.user.id, body);
  }
}