import { Module } from '@nestjs/common';

import { MessagingModule } from '@/messaging/messaging.module';
import { ContractsService } from '@/modules/contracts/contracts.service';
import { LeaseCreatedListener } from '@/modules/contracts/listeners/lease-created.listener';
import { PdfModule } from '@/modules/pdf/pdf.module';
import { StorageModule } from '@/storage/storage.module';

/**
 * Everything to do with lease contracts. It imports `MessagingModule` for a
 * connection but declares its own queue and bindings, so adding an
 * `invoice.created` listener later means a new feature module, not an edit to
 * the transport.
 *
 * `PdfModule` and `StorageModule` are the two halves of the work: render, then
 * upload. Both are shared singletons — importing `PdfModule` here reaches the
 * same `PdfService`, and so the same one Chromium, that the HTTP endpoint uses
 * rather than launching a second browser.
 */
@Module({
  imports: [MessagingModule, PdfModule, StorageModule],
  providers: [ContractsService, LeaseCreatedListener],
  exports: [ContractsService],
})
export class ContractsModule {}
