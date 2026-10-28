import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportRequestStatus } from '@prisma/client';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

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

/**
 * `scheduledAt`/`locationLabel` are only meaningful on the SCHEDULED step, but
 * the student page shows a "Schedule details" block, so marking a request
 * scheduled without saying when and where would leave the student looking at an
 * empty promise. Required for SCHEDULED, otherwise optional.
 */
const whenSchedulingOrProvided =
  (field: 'scheduledAt' | 'locationLabel') => (dto: ReviewSupportRequestDto) =>
    dto.status === SupportRequestStatus.SCHEDULED || dto[field] !== undefined;

export class ReviewSupportRequestDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES as unknown as string[])
  status!: SupportRequestStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;

  @ApiPropertyOptional({
    description:
      'ISO 8601 timestamp of the agreed meeting. Required when status is SCHEDULED.',
    example: '2026-11-04T10:30:00.000Z',
  })
  @ValidateIf(whenSchedulingOrProvided('scheduledAt'))
  @IsISO8601()
  @IsNotEmpty()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description:
      'Where the meeting happens, in the professional’s own words. Required when status is SCHEDULED.',
    example: 'Counselling office, Block C',
  })
  @ValidateIf(whenSchedulingOrProvided('locationLabel'))
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'locationLabel must contain more than whitespace' })
  @MaxLength(200)
  locationLabel?: string;
}
