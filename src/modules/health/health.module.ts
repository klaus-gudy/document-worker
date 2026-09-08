import { Module } from '@nestjs/common';

import { MessagingModule } from '@/messaging/messaging.module';
import { HealthController } from '@/modules/health/health.controller';
import { StorageModule } from '@/storage/storage.module';

/**
 * Imports `MessagingModule` and `StorageModule` purely to reach the same
 * `RabbitmqService` / `StorageService` singletons `ContractsModule` already
 * instantiated — Nest shares a module's providers across every module that
 * imports it, so this does not open a second connection to either.
 */
@Module({
  imports: [MessagingModule, StorageModule],
  controllers: [HealthController],
})
export class HealthModule {}
