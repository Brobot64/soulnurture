import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { STAFF_ROLES } from '../../users/dto/staff-bootstrap.dto.js';

export class OnboardProfessionalDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES as unknown as string[])
  role!: (typeof STAFF_ROLES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  department?: string;
}
