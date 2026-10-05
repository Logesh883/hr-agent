import { Global, Module } from '@nestjs/common';
import { LocalDiskStorage } from './local-disk.storage.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  providers: [{ provide: StorageService, useClass: LocalDiskStorage }],
  exports: [StorageService],
})
export class StorageModule {}
