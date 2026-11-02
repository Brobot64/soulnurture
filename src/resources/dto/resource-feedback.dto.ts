import { ApiProperty } from '@nestjs/swagger';
import { ResourceFeedbackChoice } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';

export class ResourceFeedbackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  resourceId!: string;

  @ApiProperty({ enum: ResourceFeedbackChoice })
  @IsEnum(ResourceFeedbackChoice)
  choice!: ResourceFeedbackChoice;
}
