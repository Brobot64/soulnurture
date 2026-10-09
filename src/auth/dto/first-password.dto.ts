import { ApiProperty } from '@nestjs/swagger';
import { MinLength } from 'class-validator';

export class FirstPasswordDto {
  @ApiProperty({
    description: 'The new personal password (minimum 8 characters).',
    minLength: 8,
  })
  @MinLength(8)
  newPassword!: string;
}
