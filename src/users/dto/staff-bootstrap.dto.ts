import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/**
 * Roles that may be assigned through the secret-gated bootstrap enrolment.
 * STUDENT is intentionally absent: plain sign-up creates student accounts.
 */
export const STAFF_ROLES = [
  UserRole.COUNSELLOR,
  UserRole.PSYCHOLOGIST,
  UserRole.SUPPORT_STAFF,
] as const;

export class StaffBootstrapDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES as unknown as string[])
  role!: UserRole;

  @ApiProperty({
    description: 'Secret enrolment key distributed by the school admin (STAFF_BOOTSTRAP_KEY)',
  })
  @IsString()
  @IsNotEmpty()
  enrollmentKey!: string;
}
