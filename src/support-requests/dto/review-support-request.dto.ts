import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportRequestStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Statuses a professional may set during review. PENDING and ESCALATED are
 * system-managed (creation/urgency), so the PATCH accepts the remaining set.
 */
const REVIEW_STATUSES: SupportRequestStatus[] = [
  SupportRequestStatus.ACCEPTED,
  SupportRequestStatus.SCHEDULED,
  SupportRequestStatus.IN_PROGRESS,
  SupportRequestStatus.COMPLETED,
  SupportRequestStatus.CANCELLED,
];

export class ReviewSupportRequestDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES as unknown as string[])
  status!: SupportRequestStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}
