import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportPersonType, SupportTiming } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateSupportRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supportPersonId!: string;

  @ApiProperty({ enum: SupportPersonType })
  @IsEnum(SupportPersonType)
  personType!: SupportPersonType;

  @ApiProperty({ enum: SupportTiming })
  @IsEnum(SupportTiming)
  timing!: SupportTiming;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  checkInId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
