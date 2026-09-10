import { Injectable, Logger } from '@nestjs/common';

import {
  CONTRACT_CONTENT_TYPE,
  CONTRACT_PDF_OPTIONS,
  FOOTER_TEXT_MAX,
} from '@/modules/contracts/contracts.constants';
import type { DocumentStoredEvent } from '@/modules/contracts/events/document-stored.event';
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

  /**
   * Renders and stores the document, and reports back what landed where.
   *
   * The return value is deliberately everything a caller would need to
   * announce completion to something else — object key, content type, size,
   * timestamp, and the publisher's own `meta` handed straight back — without
   * this service knowing that announcing is a thing that happens. That stays the listener's job: publishing is a broker concern,
   * and injecting `RabbitmqService` here would mean this could no longer be
   * exercised from an HTTP route or a test with no broker in sight, which is
   * the whole reason it is separate from the listener to begin with.
   */
  async handleLeaseCreated(
    event: LeaseCreatedEvent,
  ): Promise<DocumentStoredEvent> {
    const startedAt = Date.now();

    /*
     * `CONTRACT_PDF_OPTIONS` decides the layout and the message never gets a
     * say in it — a stored contract is a record, and one laid out however the
     * publisher felt that day is one nobody can reproduce.
     *
     * `footerText` is the single exception, and it is an exception about
     * *content*, not layout: the words are a template name and a contract
     * reference that only the publisher knows, while whether a footer is drawn
     * and what it looks like stay decided here. `PdfService` escapes it before
     * it reaches Chromium's footer template, so a stray `<` cannot forge
     * markup; the cap is about a runaway string, not injection.
     */
    const footerText = normaliseFooter(event.footerText);

    const pdf = await this.pdf.render(event.html, {
      ...CONTRACT_PDF_OPTIONS,
      ...(footerText ? { footerText } : {}),
    });
    const rendered = Date.now();

    await this.storage.putObject(event.objectKey, pdf, CONTRACT_CONTENT_TYPE);
    const storedAt = new Date().toISOString();

    this.logger.log(
      `stored ${event.objectKey} — ${pdf.byteLength} bytes ` +
        `(render ${rendered - startedAt}ms, upload ${Date.now() - rendered}ms)`,
    );

    return {
      objectKey: event.objectKey,
      contentType: CONTRACT_CONTENT_TYPE,
      sizeBytes: pdf.byteLength,
      storedAt,
      // Handed back exactly as it arrived. Not validated, not reshaped, not
      // even read — the moment this service starts caring what is inside it,
      // it has a domain model it was built not to have. Omitted entirely when
      // the request carried none, rather than sent as an empty object.
      ...(event.meta === undefined ? {} : { meta: event.meta }),
    };
  }
}

/**
 * The footer as this service will actually print it, or undefined for no
 * footer at all.
 *
 * A non-string, or a string that is empty once trimmed, means the publisher
 * did not ask for one — passing `''` through would set `displayHeaderFooter`
 * on an empty template, which draws the page counter alone with no reference
 * beside it.
 */
function normaliseFooter(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  return trimmed.slice(0, FOOTER_TEXT_MAX);
}
