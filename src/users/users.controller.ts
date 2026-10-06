import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('Users (contract)')
@Controller('v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiEnvelopeOk(Object)
  me(@Session() session: UserSession) {
    return this.usersService.getMe(session.user.id);
  }

  @Post()
  @Roles('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({ summary: 'Provision a new user' })
  @ApiBody({ type: CreateUserDto })
  @ApiEnvelopeOk(Object)
  create(@Body() body: CreateUserDto) {
    return this.usersService.provisionAdmin(body);
  }
}