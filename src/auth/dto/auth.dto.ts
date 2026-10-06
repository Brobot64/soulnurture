import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'amina@school.edu' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Str0ng-P@ssw0rd', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  password!: string;

  @ApiProperty({ example: 'Amina Okonkwo' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatars/amina.jpg' })
  @IsOptional()
  @IsString()
  image?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'amina@school.edu' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Str0ng-P@ssw0rd' })
  @IsString()
  password!: string;
}

export class ResendVerificationDto {
  @ApiProperty({
    example: 'amina@school.edu',
    description: 'Account email to resend verification to',
  })
  @IsEmail()
  email!: string;
}

export class ResendVerificationResultDto {
  @ApiProperty({ example: true })
  status!: boolean;
}
