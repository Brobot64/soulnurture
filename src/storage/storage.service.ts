import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STORAGE_CONFIG, type StorageConfig } from './storage.config.js';
import { buildUploadKey } from './upload-policy.js';

/** 15 minutes: enough for a 10MB PUT on a weak mobile connection. */
const PRESIGN_EXPIRY_SECONDS = 900;

const NOT_CONFIGURED_MESSAGE =
  'File uploads are not available right now — object storage is not configured on this deployment.';

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType: string;
}

interface ReadyClient {
  client: S3Client;
  bucket: string;
}

@Injectable()
export class StorageService {
  private readonly ready: ReadyClient | null;

  constructor(@Inject(STORAGE_CONFIG) config: StorageConfig) {
    const { endpoint, region, bucket, accessKey, secretKey } = config;
    this.ready =
      endpoint && bucket && accessKey && secretKey
        ? {
            bucket,
            client: new S3Client({
              endpoint,
              region,
              // MinIO serves bucket-in-path style; required for the compose
              // deployment in DEPLOYMENT.md §4.
              forcePathStyle: true,
              // Without this, the SDK embeds a CRC32 checksum computed over an
              // empty body in presigned PUT URLs, which non-AWS S3 rejects.
              requestChecksumCalculation: 'WHEN_REQUIRED',
              credentials: {
                accessKeyId: accessKey,
                secretAccessKey: secretKey,
              },
            }),
          }
        : null;
  }

  /** Throws the friendly 503 early (before any multipart bytes are read). */
  ensureAvailable(): void {
    if (!this.ready) {
      throw new ServiceUnavailableException(NOT_CONFIGURED_MESSAGE);
    }
  }

  /**
   * Sign a single PUT under `uploads/{userId}/`. The signature covers the
   * declared Content-Length, so the client must upload exactly `size` bytes.
   * Content-Type cannot be signed for presigned URLs (SDK constraint); the
   * client must send the same value it declared or the stored metadata lies.
   */
  async presignUpload(input: {
    userId: string;
    contentType: string;
    size: number;
  }): Promise<PresignedUpload> {
    const { client, bucket } = this.requireStorage();
    const key = buildUploadKey(input.userId, input.contentType);
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.size,
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );
    return { key, uploadUrl, expiresInSeconds: PRESIGN_EXPIRY_SECONDS };
  }

  /** Buffer-and-forward lane for small files that must pass through Node. */
  async uploadObject(input: {
    userId: string;
    contentType: string;
    body: Buffer;
  }): Promise<StoredObject> {
    const { client, bucket } = this.requireStorage();
    const key = buildUploadKey(input.userId, input.contentType);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
        Body: input.body,
      }),
    );
    return {
      key,
      size: input.body.byteLength,
      contentType: input.contentType,
    };
  }

  private requireStorage(): ReadyClient {
    this.ensureAvailable();
    // ensureAvailable() guarantees ready is non-null.
    return this.ready as ReadyClient;
  }
}
