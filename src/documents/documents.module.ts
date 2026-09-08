import { Module } from '@nestjs/common';

import { RabbitmqModule } from '../events/rabbitmq.module';
import { PdfModule } from '../pdf/pdf.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentRequestedConsumer } from './document-requested.consumer';
import { DocumentsService } from './documents.service';

@Module({
  imports: [RabbitmqModule, PdfModule, StorageModule],
  providers: [DocumentsService, DocumentRequestedConsumer],
  exports: [DocumentsService],
})
export class DocumentsModule {}
