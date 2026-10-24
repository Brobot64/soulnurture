import { ApiProperty } from '@nestjs/swagger';
import { FeelingIntensity, FeelingLabel } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class CreateCheckInFeedbackDto {
  @ApiProperty({ enum: FeelingLabel })
  @IsEnum(FeelingLabel)
  feeling!: FeelingLabel;

  @ApiProperty({ enum: FeelingIntensity })
  @IsEnum(FeelingIntensity)
  intensity!: FeelingIntensity;
}
