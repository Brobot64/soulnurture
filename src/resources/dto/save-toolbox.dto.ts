import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SaveToolboxDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  resourceId!: string;
}
