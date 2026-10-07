import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeelingLabel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteActivitySessionDto {
  @ApiProperty({ enum: FeelingLabel })
  @IsEnum(FeelingLabel)
  feelingAfter!: FeelingLabel;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  noteAfter?: string;
}
