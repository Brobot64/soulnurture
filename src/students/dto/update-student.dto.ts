import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SUPPORTED_LANGUAGES } from '../../ai/language/language.config.js';

export class UpdateStudentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({
    enum: SUPPORTED_LANGUAGES,
    description: 'Preferred reply language (en | pcm | yo | ha | ig)',
  })
  @IsOptional()
  @IsString()
  @IsIn([...SUPPORTED_LANGUAGES])
  preferredLanguage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vibe?: string;

  @ApiPropertyOptional({
    description: 'Class label shown on safeguarding flags (e.g. "Sociology 300 Level")',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  classLabel?: string;
}
