import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FollowUpStatus } from '@prisma/client';
import {
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const CREATABLE_STATUSES = [FollowUpStatus.PENDING, FollowUpStatus.SCHEDULED];

export class CreateFollowUpDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentId!: string;

  @ApiPropertyOptional({ enum: CREATABLE_STATUSES, default: FollowUpStatus.PENDING })
  @IsOptional()
  @IsIn(CREATABLE_STATUSES)
  status?: 'PENDING' | 'SCHEDULED';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supportRequestId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}

const UPDATABLE_STATUSES: FollowUpStatus[] = [
  FollowUpStatus.PENDING,
  FollowUpStatus.SCHEDULED,
  FollowUpStatus.COMPLETED,
  FollowUpStatus.CANCELLED,
];

export class UpdateFollowUpDto {
  @ApiPropertyOptional({ enum: UPDATABLE_STATUSES })
  @IsOptional()
  @IsIn(UPDATABLE_STATUSES as unknown as string[])
  status?: FollowUpStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}
