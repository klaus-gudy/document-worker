import { Injectable, Logger } from '@nestjs/common';

import {
  CONTRACT_CONTENT_TYPE,
  CONTRACT_PDF_OPTIONS,
} from '@/modules/contracts/contracts.constants';
import type { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';
import { PdfService } from '@/modules/pdf/pdf.service';
import { StorageService } from '@/storage/storage.service';

/**
 * What this application does when a lease is created: render the HTML it was
 * sent, and put the PDF where it was told to.
 *
 * That is the whole job, and the shortness is the point. The publisher has
 * already resolved the template, filled in the placeholders and decided the
 * object key, so there is no database here, no template engine, and no
 * knowledge of what a lease actually is — only bytes and a destination.
 *
 * Separate from the listener on purpose. The listener knows about queues, JSON
 * and acks; this knows about rendering and storage. Keeping them apart is what
 * lets this be called from an HTTP route or a test with no broker in sight.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
  ) {}

  async handleLeaseCreated(event: LeaseCreatedEvent): Promise<void> {
    const startedAt = Date.now();

    // `CONTRACT_PDF_OPTIONS`, never anything off the message. A stored contract
    // is a record, and a record laid out however the publisher felt that day is
    // one nobody can reproduce.
    const pdf = await this.pdf.render(event.html, CONTRACT_PDF_OPTIONS);
    const rendered = Date.now();

    await this.storage.putObject(event.objectKey, pdf, CONTRACT_CONTENT_TYPE);

    this.logger.log(
      `stored ${event.objectKey} — ${pdf.byteLength} bytes ` +
        `(render ${rendered - startedAt}ms, upload ${Date.now() - rendered}ms)`,
    );
  }
}
