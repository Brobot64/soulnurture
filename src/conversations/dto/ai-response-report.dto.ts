import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiReportReviewOutcome } from '@prisma/client';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateAiResponseReportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;

  @ApiProperty({ description: 'The displayed reply; must match the stored message before a report is created.' })
  @Transform(({ obj, key }: TransformFnParams) => (obj as Record<string, unknown>)[key])
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  expectedContent!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(({ obj, key }: TransformFnParams) => (obj as Record<string, unknown>)[key])
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ListAiResponseReportsDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset = 0;
}

export class MyAiResponseReportsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

export class ReviewAiResponseReportDto {
  @ApiProperty({ enum: AiReportReviewOutcome })
  @IsEnum(AiReportReviewOutcome)
  outcome!: AiReportReviewOutcome;
}
