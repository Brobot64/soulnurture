import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { UpdateStudentDto } from './dto/update-student.dto.js';
import { StudentsService } from './students.service.js';

@ApiTags('Students (contract)')
@Controller('v1/students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get student profile' })
  @ApiEnvelopeOk(Object)
  me(@Session() session: UserSession) {
    return this.studentsService.getMe(session.user.id);
  }

  @Patch('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Update student profile' })
  @ApiBody({ type: UpdateStudentDto })
  @ApiEnvelopeOk(Object)
  updateMe(@Session() session: UserSession, @Body() body: UpdateStudentDto) {
    return this.studentsService.updateMe(session.user.id, body);
  }

  @Get('me/sanctuary')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Sanctuary home' })
  @ApiEnvelopeOk(Object)
  sanctuary(@Session() session: UserSession) {
    return this.studentsService.getSanctuary(session.user.id);
  }
}
