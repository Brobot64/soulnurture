import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @ApiProperty({ example: 'Amina Okonkwo' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'amina@school.edu' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'COUNSELLOR', enum: UserRole })
  @IsNotEmpty()
  @IsString()
  role!: UserRole;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @ApiProperty({ example: 'Str0ng!Pass' })
  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  password!: string;
}