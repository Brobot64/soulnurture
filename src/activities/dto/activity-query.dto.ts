import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceCategory } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ActivityQueryDto {
  @ApiPropertyOptional({ enum: ResourceCategory })
  @IsOptional()
  @IsEnum(ResourceCategory)
  category?: ResourceCategory;
}
