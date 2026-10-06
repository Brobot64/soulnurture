import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Hard cap for every upload route — matches the global multipart limit in main.ts. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * MIME allowlist → canonical file extension. The extension is derived from the
 * declared MIME type, never from the client-supplied filename, so a crafted
 * name can never steer the stored key.
 */
export const UPLOAD_MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/ogg': '.ogg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export const UPLOAD_MIME_TYPES = Object.keys(UPLOAD_MIME_EXTENSIONS);

export function isAllowedUploadMime(mimeType: string): boolean {
  return Object.hasOwn(UPLOAD_MIME_EXTENSIONS, mimeType);
}

export function buildUploadKey(userId: string, mimeType: string): string {
  const extension = isAllowedUploadMime(mimeType)
    ? UPLOAD_MIME_EXTENSIONS[mimeType]
    : undefined;
  if (!extension) {
    throw new BadRequestException(`Unsupported file type: ${mimeType}`);
  }
  return `uploads/${userId}/${randomUUID()}${extension}`;
}
