import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import storageConfig from '@/config/storage.config';
import { StorageService } from '@/storage/storage.service';

/**
 * Infrastructure, not a feature — same reasoning as `MessagingModule`. It owns
 * the S3 client and nothing else, so whatever feature eventually generates a
 * document imports this rather than opening its own client.
 */
@Module({
  imports: [ConfigModule.forFeature(storageConfig)],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
