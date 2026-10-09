import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSchoolDto {
  @ApiProperty({
    description: 'Human-readable school name (drives the short code acronym).',
    minLength: 2,
    maxLength: 120,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Default credential for every account the school onboards. Stored as a scrypt hash, never returned. Accounts are forced to set their own password at first sign-in.',
    minLength: 8,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  defaultPassword?: string;
}
