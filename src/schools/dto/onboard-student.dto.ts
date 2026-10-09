import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class OnboardStudentDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Class or year group, e.g. "JHS 2B"' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  classLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({
    description: 'Preferred chat language (en, yo, ha, ig). Defaults to en.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  preferredLanguage?: string;
}
