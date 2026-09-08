import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ConsumeMessage } from 'amqplib';

import {
  DOCUMENT_FAILED,
  DOCUMENT_GENERATED,
  type DocumentRequestedEvent,
} from '../events/events.types';
import { RabbitmqService } from '../events/rabbitmq.service';
import { StorageService } from '../storage/storage.service';
import { DocumentRequestedConsumer } from './document-requested.consumer';
import { DocumentsService, type RenderResult } from './documents.service';

/**
 * What the consumer does with a message is the decision that costs money when
 * it is wrong: an ack on a transient failure loses a document silently, a retry
 * on a permanent one spins this process forever, and a success nobody is told
 * about leaves an orphan in the bucket. So these tests are about the routing
 * table and the announcements, not the render.
 */

const MAX_ATTEMPTS = 2;

const request: DocumentRequestedEvent = {
  requestId: 'req_1',
  organizationId: 'org_1',
  subject: { type: 'LEASE', id: 'lease_1' },
  html: '<html><body>hi</body></html>',
  fileName: 'contract-L-1.pdf',
  meta: { assetTypeId: 'sys_LEASE_CONTRACT' },
};

const success: RenderResult = {
  ok: true,
  objectKey: 'organizations/org_1/leases/lease_1/x.pdf',
  fileType: 'application/pdf',
  sizeBytes: 1024,
};

function messageOf(body: unknown, attempts?: number): ConsumeMessage {
  return {
    content: Buffer.from(
      typeof body === 'string' ? body : JSON.stringify(body),
    ),
    fields: {} as ConsumeMessage['fields'],
    properties: {
      headers: attempts === undefined ? {} : { 'x-attempts': attempts },
    } as ConsumeMessage['properties'],
  };
}

describe('DocumentRequestedConsumer', () => {
  let consumer: DocumentRequestedConsumer;
  let rabbitmq: {
    ack: jest.Mock;
    deadLetter: jest.Mock;
    republishWithAttempt: jest.Mock;
    consume: jest.Mock;
    publish: jest.Mock<
      Promise<{ ok: boolean; error?: string }>,
      [string, Record<string, unknown>]
    >;
    queue: string;
  };
  let documents: {
    renderAndStore: jest.Mock<Promise<RenderResult>, [DocumentRequestedEvent]>;
    discard: jest.Mock;
  };

  /** Reaches the private handler the AMQP callback would have called. */
  const handle = (message: ConsumeMessage) =>
    (
      consumer as unknown as { handle: (m: ConsumeMessage) => Promise<void> }
    ).handle(message);

  /** The payload of the one publish with this routing key. */
  const published = (routingKey: string): Record<string, unknown> | undefined =>
    rabbitmq.publish.mock.calls.find((call) => call[0] === routingKey)?.[1];

  beforeEach(async () => {
    rabbitmq = {
      ack: jest.fn(),
      deadLetter: jest.fn(),
      republishWithAttempt: jest.fn(),
      consume: jest.fn(),
      publish: jest
        .fn<
          Promise<{ ok: boolean; error?: string }>,
          [string, Record<string, unknown>]
        >()
        .mockResolvedValue({ ok: true }),
      queue: 'documents.generate',
    };
    documents = {
      renderAndStore: jest.fn<
        Promise<RenderResult>,
        [DocumentRequestedEvent]
      >(),
      discard: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DocumentRequestedConsumer,
        { provide: RabbitmqService, useValue: rabbitmq },
        { provide: DocumentsService, useValue: documents },
        {
          provide: StorageService,
          useValue: { objectUrl: (key: string) => key },
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => MAX_ATTEMPTS },
        },
      ],
    }).compile();

    consumer = moduleRef.get(DocumentRequestedConsumer);
  });

  it('announces a stored document and acks', async () => {
    documents.renderAndStore.mockResolvedValue(success);

    await handle(messageOf(request));

    expect(published(DOCUMENT_GENERATED)).toMatchObject({
      requestId: 'req_1',
      objectKey: success.objectKey,
      fileName: 'contract-L-1.pdf',
      sizeBytes: 1024,
      // Carried through untouched, which is how the requester knows what row
      // this belongs on without keeping its own table of pending renders.
      meta: { assetTypeId: 'sys_LEASE_CONTRACT' },
    });
    expect(rabbitmq.ack).toHaveBeenCalledTimes(1);
    expect(rabbitmq.deadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters an unparseable body without rendering anything', async () => {
    await handle(messageOf('not json'));

    expect(documents.renderAndStore).not.toHaveBeenCalled();
    expect(rabbitmq.deadLetter).toHaveBeenCalledTimes(1);
    expect(rabbitmq.publish).not.toHaveBeenCalled();
  });

  it('dead-letters an invalid request and says why, when it can be addressed', async () => {
    await handle(messageOf({ requestId: 'req_2', organizationId: 'org_1' }));

    expect(documents.renderAndStore).not.toHaveBeenCalled();
    expect(published(DOCUMENT_FAILED)).toMatchObject({
      requestId: 'req_2',
      reason: 'invalid-request',
      final: true,
    });
    expect(rabbitmq.deadLetter).toHaveBeenCalledTimes(1);
  });

  it('stays silent about an invalid request with no requestId to reply to', async () => {
    await handle(messageOf({ organizationId: 'org_1' }));

    expect(rabbitmq.publish).not.toHaveBeenCalled();
    expect(rabbitmq.deadLetter).toHaveBeenCalledTimes(1);
  });

  it('retries a render failure once, carrying the attempt count', async () => {
    documents.renderAndStore.mockResolvedValue({
      ok: false,
      reason: 'render',
      message: 'Target closed',
    });

    await handle(messageOf(request));

    expect(published(DOCUMENT_FAILED)).toMatchObject({
      reason: 'render',
      attempts: 1,
      final: false,
    });
    // Republished rather than requeued: a requeued delivery looks brand new, so
    // the counter would reset and the retry would never terminate.
    expect(rabbitmq.republishWithAttempt).toHaveBeenCalledWith(
      expect.anything(),
      1,
    );
    expect(rabbitmq.ack).toHaveBeenCalledTimes(1);
    expect(rabbitmq.deadLetter).not.toHaveBeenCalled();
  });

  it('gives up at the ceiling, and says the failure is final', async () => {
    documents.renderAndStore.mockResolvedValue({
      ok: false,
      reason: 'storage',
      message: 'bucket unreachable',
    });

    await handle(messageOf(request, MAX_ATTEMPTS - 1));

    expect(published(DOCUMENT_FAILED)).toMatchObject({
      reason: 'storage',
      attempts: MAX_ATTEMPTS,
      final: true,
    });
    expect(rabbitmq.deadLetter).toHaveBeenCalledTimes(1);
    expect(rabbitmq.republishWithAttempt).not.toHaveBeenCalled();
  });

  it('withdraws the object and retries when it cannot announce a success', async () => {
    documents.renderAndStore.mockResolvedValue(success);
    rabbitmq.publish.mockImplementation((routingKey: string) =>
      Promise.resolve(
        routingKey === DOCUMENT_GENERATED
          ? { ok: false, error: 'broker gone' }
          : { ok: true },
      ),
    );

    await handle(messageOf(request));

    // An object nobody was told about is invisible to the requester and
    // impossible for it to clean up, so it must not be left behind.
    expect(documents.discard).toHaveBeenCalledWith(success.objectKey);
    expect(rabbitmq.republishWithAttempt).toHaveBeenCalledWith(
      expect.anything(),
      1,
    );
    expect(rabbitmq.ack).toHaveBeenCalledTimes(1);
  });
});
