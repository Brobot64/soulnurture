import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AcceptConsentDto {
  @ApiProperty({ example: 'v1' })
  @IsString()
  @MinLength(1)
  version!: string;
}
