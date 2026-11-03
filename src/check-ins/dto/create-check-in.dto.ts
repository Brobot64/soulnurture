import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CheckInAnswerState, FeelingIntensity, FeelingLabel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * A feeling the student picked. `code` is the register (EMO-*) code; a term with
 * no code is the students own words, which is why the row is stored as a label
 * snapshot and flagged as free text rather than being mapped onto a code.
 */
export class CheckInFeelingDto {
  @ApiPropertyOptional({ description: 'Content register code, e.g. EMO-03.' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  code?: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  label!: string;
}

export class CheckInAnswerDto {
  @ApiProperty({ description: 'Check-in prompt code, e.g. CP-05.' })
  @IsString()
  @MaxLength(24)
  promptCode!: string;

  @ApiProperty({ enum: CheckInAnswerState })
  @IsEnum(CheckInAnswerState)
  state!: CheckInAnswerState;

  @ApiPropertyOptional({ description: 'Chosen response option code, if any.' })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  valueCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  freeText?: string;
}

export class CreateCheckInDto {
  @ApiProperty({ enum: FeelingLabel })
  @IsEnum(FeelingLabel)
  feeling!: FeelingLabel;

  @ApiProperty({ enum: FeelingIntensity })
  @IsEnum(FeelingIntensity)
  intensity!: FeelingIntensity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggers?: string[];

  @ApiPropertyOptional({ type: [CheckInFeelingDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => CheckInFeelingDto)
  feelings?: CheckInFeelingDto[];

  @ApiPropertyOptional({ type: [CheckInAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CheckInAnswerDto)
  answers?: CheckInAnswerDto[];
}
