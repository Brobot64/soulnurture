import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceCategory, ResourceType } from '@prisma/client';
import { IsBooleanString, IsEnum, IsOptional, IsString } from 'class-validator';

export class ResourceQueryDto {
  @ApiPropertyOptional({ enum: ResourceCategory })
  @IsOptional()
  @IsEnum(ResourceCategory)
  category?: ResourceCategory;

  @ApiPropertyOptional({ enum: ResourceType })
  @IsOptional()
  @IsEnum(ResourceType)
  type?: ResourceType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBooleanString()
  savedOnly?: string;
}
