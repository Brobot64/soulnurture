import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePrivacyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  shareAiCopingHubNotes?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowParentGuardianNotification?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requestPeerSupportCompanion?: boolean;
}
