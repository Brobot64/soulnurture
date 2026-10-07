import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { FastifyRequest } from 'fastify';
import {
  ApiEnvelopeOk,
  ApiSessionAuth,
  ApiStandardErrors,
} from '../docs/openapi.helpers.js';
import { PresignUploadDto } from './dto/presign-upload.dto.js';
import { StorageService } from './storage.service.js';
import { MAX_UPLOAD_BYTES, isAllowedUploadMime } from './upload-policy.js';

const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

@ApiTags('Uploads (contract)')
@Controller('v1/uploads')
export class UploadsController {
  constructor(private readonly storageService: StorageService) {}

  @Post('presign')
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiOperation({
    summary: 'Issue a presigned URL for direct-to-storage upload',
    description:
      'Signs a single PUT to `uploadUrl` (valid for `expiresInSeconds`). The signature binds the exact declared byte size — uploading a different size is rejected by storage. The client must send the same Content-Type it declared. Prefer this over the multipart route for large files: the bytes never transit the API server. Requires S3/MinIO configuration (docs/DEPLOYMENT.md §4); otherwise 503.',
  })
  @ApiBody({ type: PresignUploadDto })
  @ApiEnvelopeOk(Object)
  presign(@Session() session: UserSession, @Body() body: PresignUploadDto) {
    return this.storageService.presignUpload({
      userId: session.user.id,
      contentType: body.contentType,
      size: body.size,
    });
  }

  @Post()
  @ApiSessionAuth()
  @ApiStandardErrors()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file through the API',
    description: `Multipart field \`file\` (max ${MAX_UPLOAD_MB}MB, allowlisted types only). The API buffers the file and forwards it to storage in one PUT — convenient for small files, but the bytes transit Node; use /v1/uploads/presign for large files. Requires S3/MinIO configuration; otherwise 503.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiEnvelopeOk(Object)
  async upload(@Session() session: UserSession, @Req() req: FastifyRequest) {
    if (!req.isMultipart?.()) {
      throw new BadRequestException('Expected multipart form data');
    }
    this.storageService.ensureAvailable();

    let file: { buffer: Buffer; mimeType: string } | null = null;

    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        continue;
      }
      if (part.fieldname !== 'file' || file) {
        part.file.resume();
        continue;
      }
      if (!isAllowedUploadMime(part.mimetype)) {
        throw new BadRequestException(
          `Unsupported file type: ${part.mimetype}`,
        );
      }
      const buffer = await part.toBuffer();
      if (buffer.byteLength > MAX_UPLOAD_BYTES) {
        throw new BadRequestException(`File too large (max ${MAX_UPLOAD_MB}MB)`);
      }
      file = { buffer, mimeType: part.mimetype };
    }

    if (!file) {
      throw new BadRequestException('file is required');
    }

    return this.storageService.uploadObject({
      userId: session.user.id,
      contentType: file.mimeType,
      body: file.buffer,
    });
  }
}
