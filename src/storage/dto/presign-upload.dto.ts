import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES } from '../upload-policy.js';

export class PresignUploadDto {
  @ApiProperty({
    description: 'MIME type of the file that will be PUT to the signed URL.',
    enum: UPLOAD_MIME_TYPES,
    example: 'image/jpeg',
  })
  @IsIn(UPLOAD_MIME_TYPES)
  contentType!: string;

  @ApiProperty({
    description: 'Exact file size in bytes — bound into the URL signature.',
    example: 284_313,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_UPLOAD_BYTES)
  size!: number;
}
