import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeelingIntensity, FeelingLabel } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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
}
