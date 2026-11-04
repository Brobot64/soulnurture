import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HistoryDeletionScope } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Epic H "Ask to delete your history?". This creates a request, not a
 * deletion — see `HistoryDeletionService`. Which extra fields are required
 * depends on `scope`, and that pairing is checked server-side, because a
 * client that could name any subset would let a "delete everything" ask carry
 * a date nobody meant.
 */
export class RequestHistoryDeletionDto {
  @ApiProperty({
    enum: HistoryDeletionScope,
    enumName: 'HistoryDeletionScope',
    description:
      'ALL_HISTORY · BEFORE_DATE (needs beforeDate) · SELECTED_CHECK_INS (needs checkInIds)',
  })
  @IsEnum(HistoryDeletionScope)
  scope!: HistoryDeletionScope;

  @ApiPropertyOptional({
    format: 'date',
    description: 'ISO date. Required for BEFORE_DATE, rejected for any other scope',
    example: '2026-10-01',
  })
  @IsOptional()
  @IsDateString()
  beforeDate?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'The student’s own check-in ids. Required for SELECTED_CHECK_INS',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(200)
  checkInIds?: string[];

  @ApiPropertyOptional({
    description: 'Why the student wants this removed, in their own words',
    example: 'I don’t want those weeks kept.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
