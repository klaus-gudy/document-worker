import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';

import rabbitmqConfig from '../config/rabbitmq.config';

/** What a feature module needs to declare to receive its events. */
export type Subscription = {
  /** The queue this listener owns. One queue per listener, never shared. */
  queue: string;
  /** Routing keys to bind it to on the exchange. */
  routingKeys: string[];
};

/**
 * The connection to RabbitMQ. **Transport only** — it knows nothing about
 * leases, contracts, or any other feature.
 *
 * That separation is the point of this module. An earlier version asserted the
 * `lease.created` queue inside this service, which meant adding a second
 * listener would have meant editing the connection code. Features now declare
 * their own topology through `subscribe`, and this stays a socket and a channel.
 *
 * Written against `amqplib` directly rather than `@nestjs/microservices`'s RMQ
 * transport, which owns the wire format: it wraps every body in its own
 * `{ pattern, data }` envelope and binds queues by pattern name. A publisher
 * sending plain JSON to a topic exchange would not be understood, and its
 * messages would be dropped as unroutable.
 */
@Injectable()
export class RabbitmqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitmqService.name);

  private connection?: ChannelModel;
  private channel?: Channel;

  constructor(
    @Inject(rabbitmqConfig.KEY)
    private readonly config: ConfigType<typeof rabbitmqConfig>,
  ) {}

  async onModuleInit() {
    this.connection = await connect(this.config.url);
    this.channel = await this.connection.createChannel();

    // Asserted, not assumed. Idempotent while the arguments match, so this app
    // can start before the publisher has ever run — otherwise a topic exchange
    // with no bound queue silently drops everything it receives.
    await this.channel.assertExchange(this.config.exchange, 'topic', {
      durable: true,
    });
    await this.channel.prefetch(this.config.prefetch);

    this.connection.on('error', (error: Error) =>
      this.logger.error(`connection error: ${error.message}`),
    );
    this.connection.on('close', () => this.logger.warn('connection closed'));

    this.logger.log(
      `connected to ${this.config.url} — exchange "${this.config.exchange}"`,
    );
  }

  /**
   * Declares a listener's queue, binds it, and starts delivering.
   *
   * The queue is durable and the binding is re-asserted on every boot, so a
   * message published while this process was down is waiting when it returns
   * rather than having been dropped.
   */
  async subscribe(
    subscription: Subscription,
    handler: (message: ConsumeMessage) => void,
  ): Promise<string> {
    const channel = this.getChannel();

    await channel.assertQueue(subscription.queue, { durable: true });
    for (const routingKey of subscription.routingKeys) {
      await channel.bindQueue(
        subscription.queue,
        this.config.exchange,
        routingKey,
      );
    }

    const { consumerTag } = await channel.consume(
      subscription.queue,
      (message) => {
        // A null delivery means the consumer was cancelled broker-side — there
        // is nothing to ack and nothing to handle.
        if (!message) return;
        handler(message);
      },
    );

    return consumerTag;
  }

  getChannel(): Channel {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not open');
    }
    return this.channel;
  }

  ack(message: ConsumeMessage) {
    this.getChannel().ack(message);
  }

  /**
   * Rejects without requeueing.
   *
   * `requeue: true` is deliberately not offered: a rejected message put back at
   * the head of the queue is redelivered immediately, so this process would
   * spin on it forever and every valid message behind it would wait.
   */
  reject(message: ConsumeMessage) {
    this.getChannel().nack(message, false, false);
  }

  /**
   * Closes the channel then the connection, in that order.
   *
   * Without this, SIGTERM drops the socket mid-message and the broker waits out
   * a timeout before redelivering. Closing properly hands anything unacked back
   * immediately.
   */
  async onApplicationShutdown() {
    try {
      await this.channel?.close();
      await this.connection?.close();
      this.logger.log('connection closed cleanly');
    } catch {
      // Already closing, or the socket is gone. Nothing left to close.
    } finally {
      this.channel = undefined;
      this.connection = undefined;
    }
  }
}
