import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateChatThreadDto {
  @ApiPropertyOptional({
    description: "Optional note for the professional; its gist is woven into the entry note.",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Check-in to attach; defaults to the latest one.',
  })
  @IsOptional()
  @IsUUID()
  checkInId?: string;
}
