import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateConversationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  checkInId?: string;

  @ApiPropertyOptional({ example: 'chat' })
  @IsOptional()
  @IsString()
  source?: string;
}
