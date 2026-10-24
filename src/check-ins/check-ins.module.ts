import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StudentsModule } from '../students/students.module.js';
import { CheckInFeedbackController } from './check-in-feedback.controller.js';
import { CheckInFeedbackReportController } from './check-in-feedback-report.controller.js';
import { CheckInFeedbackService } from './check-in-feedback.service.js';
import { CheckInsController } from './check-ins.controller.js';
import { CheckInsService } from './check-ins.service.js';

@Module({
  imports: [PrismaModule, StudentsModule],
  controllers: [
    CheckInsController,
    CheckInFeedbackController,
    CheckInFeedbackReportController,
  ],
  providers: [CheckInsService, CheckInFeedbackService],
  exports: [CheckInsService, CheckInFeedbackService],
})
export class CheckInsModule {}
