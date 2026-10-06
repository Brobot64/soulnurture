import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service.js';
import { UploadsController } from './uploads.controller.js';
import { STORAGE_CONFIG, buildStorageConfig } from './storage.config.js';

@Module({
  imports: [ConfigModule],
  controllers: [UploadsController],
  providers: [
    {
      provide: STORAGE_CONFIG,
      useFactory: buildStorageConfig,
      inject: [ConfigService],
    },
    StorageService,
  ],
})
export class StorageModule {}
