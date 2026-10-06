import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MockInstance } from 'vitest';
import type { StorageConfig } from './storage.config.js';
import { StorageService } from './storage.service.js';

const CONFIGURED: StorageConfig = {
  endpoint: 'https://s3.test.local',
  region: 'us-east-1',
  bucket: 'natlas-uploads',
  accessKey: 'AKIATEST',
  secretKey: 'secret',
};

const UNCONFIGURED: StorageConfig = {
  endpoint: null,
  region: 'us-east-1',
  bucket: null,
  accessKey: null,
  secretKey: null,
};

describe('StorageService', () => {
  describe('without object storage configured', () => {
    const service = new StorageService(UNCONFIGURED);

    it('answers presign with the friendly 503', async () => {
      await expect(
        service.presignUpload({
          userId: 'user-1',
          contentType: 'image/jpeg',
          size: 10,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('answers direct upload with the friendly 503', async () => {
      await expect(
        service.uploadObject({
          userId: 'user-1',
          contentType: 'image/jpeg',
          body: Buffer.from('x'),
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(() => service.ensureAvailable()).toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('with object storage configured', () => {
    let service: StorageService;
    let sendSpy: MockInstance;

    beforeEach(() => {
      sendSpy = vi
        .spyOn(S3Client.prototype, 'send')
        .mockResolvedValue({} as never);
      service = new StorageService(CONFIGURED);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('presigns a size-bound PUT under uploads/{userId}/ with a canonical extension', async () => {
      const result = await service.presignUpload({
        userId: 'user-1',
        contentType: 'image/jpeg',
        size: 1234,
      });

      expect(result.key).toMatch(/^uploads\/user-1\/[0-9a-f-]{36}\.jpg$/);
      expect(result.expiresInSeconds).toBe(900);

      const url = new URL(result.uploadUrl);
      expect(url.origin).toBe('https://s3.test.local');
      expect(url.pathname).toBe(`/natlas-uploads/${result.key}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      // The declared size is part of the signature: storage rejects a body of
      // any other length.
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;host',
      );
      // No empty-body CRC32 placeholder — non-AWS S3 rejects those PUTs.
      expect(url.searchParams.get('x-amz-checksum-crc32')).toBeNull();
      // Signing is local; presigning must not touch the network.
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('maps each allowlisted MIME type to its canonical extension', async () => {
      const webm = await service.presignUpload({
        userId: 'user-1',
        contentType: 'audio/webm',
        size: 10,
      });
      const pdf = await service.presignUpload({
        userId: 'user-1',
        contentType: 'application/pdf',
        size: 10,
      });

      expect(webm.key.endsWith('.webm')).toBe(true);
      expect(pdf.key.endsWith('.pdf')).toBe(true);
      expect(webm.key).not.toBe(pdf.key);
    });

    it('rejects a MIME type outside the allowlist', async () => {
      await expect(
        service.presignUpload({
          userId: 'user-1',
          contentType: 'text/html',
          size: 10,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.uploadObject({
          userId: 'user-1',
          contentType: 'text/html',
          body: Buffer.from('x'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('forwards a buffered object with one signed PUT', async () => {
      const body = Buffer.from('hello');

      const stored = await service.uploadObject({
        userId: 'user-1',
        contentType: 'application/pdf',
        body,
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const command = sendSpy.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'natlas-uploads',
        Key: stored.key,
        ContentType: 'application/pdf',
        ContentLength: 5,
        Body: body,
      });
      expect(stored.size).toBe(5);
      expect(stored.key).toMatch(/^uploads\/user-1\/[0-9a-f-]{36}\.pdf$/);
    });
  });
});
