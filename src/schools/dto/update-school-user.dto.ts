import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateSchoolUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'Student class/year group' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  classLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8)
  preferredLanguage?: string;

  @ApiPropertyOptional({ description: 'Professional job title' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional({ description: 'Professional department' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  department?: string;
}
