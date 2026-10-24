import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import {
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { Roles } from '../common/guards/roles.decorator.js';
import { CheckInFeedbackService } from './check-in-feedback.service.js';

@ApiTags('Platform admin — check-in mood feedback')
@Controller('v1/admin/check-in-feedback')
@Roles('PLATFORM_ADMIN')
export class CheckInFeedbackReportController {
  constructor(private readonly feedbackService: CheckInFeedbackService) {}

  @Get('report')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Check-in mood-effect export (platform admin)',
    description: `
One CSV row per submitted post-check-in feedback: the check-in's before
feeling/intensity, the student's after feeling/intensity, and the computed
moodEffect (IMPROVED / SAME / WORSENED on a signed intensity scale — positive
feelings score +1..+3, negative -1..-3; the delta decides the effect).
Deactivated students are excluded; an optional \`schoolId\` scopes the rows.
Bypasses the JSON envelope: the response body is the raw CSV file.
`,
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Preset window in days, 1–366 (default 30)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Custom window start (YYYY-MM-DD, inclusive); requires `to`',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Custom window end (YYYY-MM-DD, inclusive); requires `from`',
  })
  @ApiQuery({
    name: 'schoolId',
    required: false,
    description: 'Scope the rows to a single school',
  })
  async report(
    @Query('days') days: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('schoolId') schoolId: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const { csv, filename } = await this.feedbackService.moodEffectReport({
      days,
      from,
      to,
      schoolId,
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);
  }
}
