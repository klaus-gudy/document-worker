import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type RecoveringChannelModel,
} from 'amqplib';

import {
  DOCUMENT_REQUESTED,
  type DomainEvent,
  type PublishedRoutingKey,
} from './events.types';

/**
 * The connection to the event bus, and the topology this worker depends on.
 *
 * Written against `amqplib` directly rather than `@nestjs/microservices`'s RMQ
 * transport, for a reason that is not stylistic: that transport owns the wire
 * format. It wraps every body in its own `{ pattern, data }` envelope and binds
 * a queue by pattern name, while the producer here publishes a bare JSON event
 * to a *topic* exchange. Using the transport would mean dictating the
 * publisher's dialect from the consumer's side.
 *
 * Two channels, deliberately. The consumer channel carries a prefetch window
 * and unacked deliveries; the publisher channel waits for broker confirms.
 * Sharing one would let a slow confirm stall delivery of the next request.
 */
@Injectable()
export class RabbitmqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitmqService.name);

  private model?: RecoveringChannelModel;
  private consumerChannel?: Channel;
  private publisherChannel?: ConfirmChannel;

  readonly exchange: string;
  readonly deadLetterExchange: string;
  readonly queue: string;
  readonly deadLetterQueue: string;
  /** What `queue` binds to on the events exchange. */
  readonly bindings = [DOCUMENT_REQUESTED];

  constructor(private readonly config: ConfigService) {
    this.exchange = this.config.getOrThrow<string>('EVENTS_EXCHANGE');
    this.deadLetterExchange = `${this.exchange}.dlx`;
    this.queue = this.config.getOrThrow<string>('DOCUMENT_QUEUE');
    this.deadLetterQueue = `${this.queue}.dead`;
  }

  async onModuleInit() {
    const url = this.config.getOrThrow<string>('RABBITMQ_URL');

    this.model = await connect(url, {
      // Re-asserted on every reconnect, not just the first: a broker restarted
      // from an empty volume comes back with no exchanges at all, and a worker
      // that assumes otherwise consumes from a queue that is not there.
      //
      // Annotated because `RecoveryOptions.setup` is a union of a promise form
      // and a callback form, which leaves the parameter inferred as `any`.
      recovery: {
        setup: (model: ChannelModel) => this.declareTopology(model),
      },
    });

    this.model.on('disconnect', (error: Error) =>
      this.logger.error(`RabbitMQ disconnected: ${error.message}`),
    );
    this.model.on('reconnect-scheduled', ({ attempt, delay }) =>
      this.logger.warn(`RabbitMQ reconnect attempt ${attempt} in ${delay}ms`),
    );
    this.model.on('error', (error: Error) =>
      this.logger.error(`RabbitMQ error: ${error.message}`),
    );

    this.consumerChannel = await this.model.createChannel();
    await this.consumerChannel.prefetch(
      this.config.getOrThrow<number>('DOCUMENT_PREFETCH'),
    );
    this.publisherChannel = await this.model.createConfirmChannel();

    this.logger.log(`connected to ${this.exchange}`);
  }

  /**
   * The exchanges, queues and bindings this worker consumes through.
   *
   * `assertExchange` and `assertQueue` are idempotent as long as the arguments
   * agree, which is the catch worth naming: if this and the publisher's own
   * declaration ever disagree about `durable` or the dead-letter exchange,
   * whichever declares second gets a `PRECONDITION_FAILED` and its channel
   * closes underneath it.
   */
  private async declareTopology(model: ChannelModel) {
    const channel = await model.createChannel();

    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    await channel.assertExchange(this.deadLetterExchange, 'fanout', {
      durable: true,
    });

    await channel.assertQueue(this.queue, {
      durable: true,
      deadLetterExchange: this.deadLetterExchange,
    });
    for (const binding of this.bindings) {
      await channel.bindQueue(this.queue, this.exchange, binding);
    }

    await channel.assertQueue(this.deadLetterQueue, { durable: true });
    await channel.bindQueue(this.deadLetterQueue, this.deadLetterExchange, '');

    await channel.close();
  }

  private requireConsumer(): Channel {
    if (!this.consumerChannel) throw new Error('RabbitMQ channel is not open');
    return this.consumerChannel;
  }

  /** Starts delivering from `queue`. Returns the consumer tag. */
  async consume(handler: (message: ConsumeMessage) => Promise<void>) {
    const { consumerTag } = await this.requireConsumer().consume(
      this.queue,
      (message) => {
        // A null delivery means the consumer was cancelled broker-side; there
        // is nothing to ack and nothing to do.
        if (!message) return;
        void handler(message);
      },
    );

    return consumerTag;
  }

  ack(message: ConsumeMessage) {
    this.requireConsumer().ack(message);
  }

  /**
   * Rejects without requeueing, which sends the message to the dead-letter
   * exchange. `requeue: true` is deliberately not offered: a requeued delivery
   * looks brand new, so the attempt counter resets and the retry never
   * terminates. Retrying is `republishWithAttempt`'s job.
   */
  deadLetter(message: ConsumeMessage) {
    this.requireConsumer().nack(message, false, false);
  }

  /**
   * Puts the message back for one more go, carrying the attempt count with it.
   *
   * Published straight to the queue rather than through the exchange, so a
   * retry cannot fan out to some *other* consumer that happens to bind the same
   * routing key — this is one job's retry, not the request happening again.
   */
  republishWithAttempt(message: ConsumeMessage, attempts: number) {
    this.requireConsumer().publish('', this.queue, message.content, {
      ...message.properties,
      headers: { ...message.properties.headers, 'x-attempts': attempts },
    });
  }

  /**
   * Tells the bus what happened to a request.
   *
   * **Never throws.** The work it describes is already done — the PDF is in the
   * bucket, or it definitively is not — and a broker hiccup while reporting
   * that must not turn a rendered document into a retry that renders it again.
   * A failed publish is logged and the caller carries on.
   */
  async publish<K extends PublishedRoutingKey>(
    routingKey: K,
    payload: DomainEvent[K],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      if (!this.publisherChannel)
        throw new Error('publisher channel is not open');

      this.publisherChannel.publish(
        this.exchange,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        {
          // Survives a broker restart, which a durable queue on its own does
          // not guarantee for the messages already sitting in it.
          persistent: true,
          contentType: 'application/json',
          contentEncoding: 'utf-8',
          type: routingKey,
          timestamp: Date.now(),
          correlationId: payload.requestId,
        },
      );

      await this.publisherChannel.waitForConfirms();
      return { ok: true };
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`failed to publish ${routingKey}: ${error}`);
      return { ok: false, error };
    }
  }

  async onApplicationShutdown() {
    try {
      await this.consumerChannel?.close();
      await this.publisherChannel?.close();
      await this.model?.close();
    } catch {
      // Already closing, or the socket is gone. Either way there is nothing
      // left to close and nothing useful to say about it.
    } finally {
      this.consumerChannel = undefined;
      this.publisherChannel = undefined;
      this.model = undefined;
    }
  }
}
