import type { ConfigService } from '@nestjs/config';

/**
 * Object storage (S3 / MinIO) for the upload routes — see docs/DEPLOYMENT.md §4.
 * All of endpoint/bucket/accessKey/secretKey must be present for uploads to
 * work; otherwise the upload endpoints answer 503 and the rest of the API is
 * unaffected.
 */
export interface StorageConfig {
  endpoint: string | null;
  region: string;
  bucket: string | null;
  accessKey: string | null;
  secretKey: string | null;
}

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

export function buildStorageConfig(config: ConfigService): StorageConfig {
  return {
    endpoint: config.get<string>('S3_ENDPOINT')?.trim() || null,
    region: config.get<string>('S3_REGION')?.trim() || 'us-east-1',
    bucket: config.get<string>('S3_BUCKET')?.trim() || null,
    accessKey: config.get<string>('S3_ACCESS_KEY')?.trim() || null,
    secretKey: config.get<string>('S3_SECRET_KEY')?.trim() || null,
  };
}
