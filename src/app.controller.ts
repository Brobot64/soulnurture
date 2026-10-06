import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { AppService } from './app.service.js';

@ApiTags('Health (live)')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @AllowAnonymous()
  @ApiOperation({
    summary: 'API root liveness',
    description: '**Live.** Simple hello payload confirming the Nest app is up.',
  })
  @ApiOkResponse({
    description: 'Request successful',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        message: { type: 'string', example: 'Request successful' },
        data: { type: 'string', example: 'Hello World!' },
        path: { type: 'string', example: '/api' },
        timestamp: { type: 'string', example: '2026-03-24T12:00:00.000Z' },
      },
    },
  })
  getHello(): string {
    return this.appService.getHello();
  }
}
