import { Injectable, Logger } from '@nestjs/common';

import { ACCEPTED_FILE_TYPES, PDF_MIME_TYPE } from '../common/file-types';
import type { DocumentRequestedEvent } from '../events/events.types';
import { PdfService } from '../pdf/pdf.service';
import { StorageService } from '../storage/storage.service';
import { buildObjectKey } from './object-key';

/**
 * The whole job: HTML in, a stored PDF out.
 *
 * There is no database here, and that is the point. The requester has already
 * decided what the document says and what it is filed against; this renders it
 * and puts the bytes somewhere. Everything that used to make this service need
 * a schema — resolving a template, joining a lease to its tenant, writing a
 * `FileAsset` row — belongs to the side that owns the data, and it tells us the
 * answer in the message.
 */

export type RenderResult =
  | {
      ok: true;
      objectKey: string;
      fileType: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      /**
       * Which half failed, because the two deserve different treatment: a
       * render failure is usually a dead browser and worth a retry, a storage
       * failure is usually a bucket that blinked and also worth one — but a
       * caller that cannot tell them apart cannot say anything useful in a log.
       */
      reason: 'render' | 'storage';
      message: string;
    };

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly pdf: PdfService,
    private readonly storage: StorageService,
  ) {}

  async renderAndStore(request: DocumentRequestedEvent): Promise<RenderResult> {
    let bytes: Uint8Array;

    try {
      bytes = await this.pdf.htmlToPdf(request.html, request.render);
    } catch (cause) {
      return {
        ok: false,
        reason: 'render',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    // The extension comes from the type this worker produces, never from
    // `fileName` — a supplied name is whatever the requester felt like sending.
    const { extension } = ACCEPTED_FILE_TYPES[PDF_MIME_TYPE];

    const objectKey = buildObjectKey({
      organizationId: request.organizationId,
      subjectType: request.subject.type,
      subjectId: request.subject.id,
      extension,
    });

    try {
      await this.storage.putObject(objectKey, bytes, PDF_MIME_TYPE);
    } catch (cause) {
      return {
        ok: false,
        reason: 'storage',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }

    return {
      ok: true,
      objectKey,
      fileType: PDF_MIME_TYPE,
      sizeBytes: bytes.byteLength,
    };
  }

  /**
   * Removes an object this worker wrote.
   *
   * Used when the bytes landed but saying so did not: an object nobody was told
   * about is invisible to the app and impossible to clean up on purpose, so it
   * is better withdrawn than left. Deleting a key that isn't there is a success
   * in S3, which makes this safe to call twice.
   */
  async discard(objectKey: string) {
    try {
      await this.storage.deleteObject(objectKey);
      this.logger.warn(`withdrew unannounced object ${objectKey}`);
    } catch (cause) {
      // Already failing; an orphaned object is the lesser problem, and naming
      // it in the log is the only thing left that helps.
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`could not withdraw ${objectKey}: ${message}`);
    }
  }
}
