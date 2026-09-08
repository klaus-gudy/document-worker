import { Module } from '@nestjs/common';

import { MessagingModule } from '@/messaging/messaging.module';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { LeaseCreatedListener } from '@/modules/contracts/listeners/lease-created.listener';

/**
 * Everything to do with lease contracts. It imports `MessagingModule` for a
 * connection but declares its own queue and bindings, so adding an
 * `invoice.created` listener later means a new feature module, not an edit to
 * the transport.
 */
@Module({
  imports: [MessagingModule],
  providers: [ContractsService, LeaseCreatedListener],
  exports: [ContractsService],
})
export class ContractsModule {}
