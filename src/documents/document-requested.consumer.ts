import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';

import {
  DOCUMENT_FAILED,
  DOCUMENT_GENERATED,
  validateDocumentRequest,
  type DocumentFailureReason,
  type DocumentRequestedEvent,
} from '../events/events.types';
import { RabbitmqService } from '../events/rabbitmq.service';
import { StorageService } from '../storage/storage.service';
import { DocumentsService } from './documents.service';

/**
 * Renders whatever the bus asks for.
 *
 * A separate process from the app that asks, for two reasons: rendering means
 * launching a browser, and the request must not fail because object storage is
 * briefly down. The requester commits its own work, puts `document.requested`
 * on the bus, and whatever happens next happens on its own time — including
 * "the worker was off for an hour", which a durable queue turns into an hour's
 * delay rather than an hour of missing documents.
 *
 * Started on `onApplicationBootstrap` rather than `onModuleInit`, deliberately:
 * by then the S3 client is built and the AMQP topology is declared. Consuming
 * before those are ready would mean failing the first request for reasons that
 * have nothing to do with the request.
 */
@Injectable()
export class DocumentRequestedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentRequestedConsumer.name);

  private readonly maxAttempts: number;

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly documents: DocumentsService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.maxAttempts = config.getOrThrow<number>('DOCUMENT_MAX_ATTEMPTS');
  }

  async onApplicationBootstrap() {
    await this.rabbitmq.consume((message) => this.handle(message));
    this.logger.log(`consuming ${this.rabbitmq.queue}`);
  }

  /** How many times this exact message has already been tried. */
  private attemptsOf(headers: Record<string, unknown> | undefined) {
    const raw = headers?.['x-attempts'];
    return typeof raw === 'number' ? raw : 0;
  }

  /**
   * Tells the requester it did not work.
   *
   * Sent on **every** attempt, not only the last, with `final` saying which
   * this was. A requester watching a document that is about to be retried and
   * one that has been abandoned needs to show different things, and only this
   * worker knows the difference.
   */
  private announceFailure(
    request: Pick<
      DocumentRequestedEvent,
      'requestId' | 'organizationId' | 'subject' | 'meta'
    >,
    reason: DocumentFailureReason,
    message: string,
    attempts: number,
    final: boolean,
  ) {
    return this.rabbitmq.publish(DOCUMENT_FAILED, {
      requestId: request.requestId,
      organizationId: request.organizationId,
      subject: request.subject,
      reason,
      message,
      attempts,
      final,
      failedAt: new Date().toISOString(),
      meta: request.meta,
    });
  }

  private async handle(message: ConsumeMessage) {
    const attempts = this.attemptsOf(message.properties.headers) + 1;

    let payload: unknown;
    try {
      payload = JSON.parse(message.content.toString());
    } catch {
      // Unparseable will never become parseable. Straight to the dead-letter
      // queue, where a person can look at it, rather than round and round the
      // retry loop. Nothing is announced because there is no requestId to
      // announce it against.
      this.logger.error('dropping unparseable message');
      this.rabbitmq.deadLetter(message);
      return;
    }

    const problem = validateDocumentRequest(payload);
    if (problem) {
      this.logger.error(`dropping invalid request: ${problem}`);

      // Announced only if there is enough of a request to address the reply to.
      // A malformed message with a requestId still deserves a reply; one
      // without is a message nobody is waiting on.
      const partial = payload as Partial<DocumentRequestedEvent>;
      if (typeof partial?.requestId === 'string' && partial.requestId) {
        await this.announceFailure(
          {
            requestId: partial.requestId,
            organizationId: partial.organizationId ?? '',
            subject: partial.subject ?? { type: 'UNKNOWN', id: null },
            meta: partial.meta,
          },
          'invalid-request',
          problem,
          attempts,
          true,
        );
      }

      this.rabbitmq.deadLetter(message);
      return;
    }

    const request = payload as DocumentRequestedEvent;
    const label = `${request.requestId} (${request.subject.type} ${request.subject.id ?? '—'}, org ${request.organizationId})`;

    const result = await this.documents.renderAndStore(request);

    if (!result.ok) {
      await this.retryOrGiveUp(
        message,
        request,
        label,
        result.reason,
        result.message,
        attempts,
      );
      return;
    }

    const announced = await this.rabbitmq.publish(DOCUMENT_GENERATED, {
      requestId: request.requestId,
      organizationId: request.organizationId,
      subject: request.subject,
      objectKey: result.objectKey,
      fileName: request.fileName,
      fileType: result.fileType,
      sizeBytes: result.sizeBytes,
      generatedAt: new Date().toISOString(),
      meta: request.meta,
    });

    if (!announced.ok) {
      /*
       * The bytes are in the bucket and nobody has been told. That object is
       * invisible to the requester and impossible for it to clean up, so it is
       * withdrawn and the whole request retried — re-rendering is cheap
       * compared to a bucket slowly filling with documents no row points at.
       */
      await this.documents.discard(result.objectKey);
      await this.retryOrGiveUp(
        message,
        request,
        label,
        'storage',
        `rendered, but could not announce it: ${announced.error}`,
        attempts,
      );
      return;
    }

    this.logger.log(
      `filed ${request.fileName} for ${label} at ${this.storage.objectUrl(result.objectKey)} (${result.sizeBytes} bytes)`,
    );
    this.rabbitmq.ack(message);
  }

  private async retryOrGiveUp(
    message: ConsumeMessage,
    request: DocumentRequestedEvent,
    label: string,
    reason: DocumentFailureReason,
    detail: string,
    attempts: number,
  ) {
    const final = attempts >= this.maxAttempts;

    this.logger.error(
      `attempt ${attempts}/${this.maxAttempts} failed for ${label}: ${detail}`,
    );

    await this.announceFailure(request, reason, detail, attempts, final);

    if (final) {
      this.rabbitmq.deadLetter(message);
      return;
    }

    // Republished rather than nacked with `requeue: true`, so the attempt count
    // travels with the message — a requeued delivery looks brand new, and the
    // retry would never terminate.
    this.rabbitmq.republishWithAttempt(message, attempts);
    this.rabbitmq.ack(message);
  }
}
