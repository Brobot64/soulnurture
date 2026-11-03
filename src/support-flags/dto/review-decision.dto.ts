import { ApiProperty } from '@nestjs/swagger';
import { SupportFlagReviewDecision } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * The three choices are the whole enum: no fourth "resolved" option exists here,
 * because recording a decision must not close the flag (Doc A US-D10).
 */
export class ReviewDecisionDto {
  @ApiProperty({ enum: SupportFlagReviewDecision })
  @IsEnum(SupportFlagReviewDecision)
  decision!: SupportFlagReviewDecision;
}
