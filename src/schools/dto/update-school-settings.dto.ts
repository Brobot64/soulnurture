import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class UpdateSchoolSettingsDto {
  @ApiProperty({
    description:
      'Default credential for every account the school onboards. Stored as a scrypt hash; never returned or logged.',
    minLength: 8,
  })
  @IsString()
  @MinLength(8)
  defaultPassword!: string;
}
