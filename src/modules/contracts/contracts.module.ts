import { Module } from '@nestjs/common';

import { MessagingModule } from '@/messaging/messaging.module';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { LeaseCreatedListener } from '@/modules/contracts/listeners/lease-created.listener';
import { StorageModule } from '@/storage/storage.module';

/**
 * Everything to do with lease contracts. It imports `MessagingModule` for a
 * connection but declares its own queue and bindings, so adding an
 * `invoice.created` listener later means a new feature module, not an edit to
 * the transport.
 *
 * `StorageModule` is imported here, not injected anywhere yet. This module is
 * where a generated contract will eventually be uploaded, so this is where the
 * dependency belongs — the import alone is enough for Nest to instantiate
 * `StorageService` and run its startup bucket check, ahead of anything actually
 * calling it.
 */
@Module({
  imports: [MessagingModule, StorageModule],
  providers: [ContractsService, LeaseCreatedListener],
  exports: [ContractsService],
})
export class ContractsModule {}
