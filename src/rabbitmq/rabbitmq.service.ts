import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type ChannelModel, type Channel } from 'amqplib';

import {
  EVENTS_EXCHANGE,
  LEASE_CREATED,
  LEASE_CREATED_QUEUE,
} from './rabbitmq.constants';

/**
 * The connection to RabbitMQ, and the exchange/queue this app listens on.
 *
 * Written against `amqplib` directly rather than `@nestjs/microservices`'s RMQ
 * transport. The transport is the idiomatic Nest choice when Nest is on both
 * ends, but it owns the wire format — it wraps every body in its own
 * `{ pattern, data }` envelope and binds queues by pattern name. A publisher
 * that sends plain JSON to a topic exchange (which is what `lease.created` is)
 * would not be understood, and its messages would be dropped as unroutable.
 * Talking AMQP directly means any publisher can reach this listener.
 */
@Injectable()
export class RabbitmqService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitmqService.name);

  private connection?: ChannelModel;
  private channel?: Channel;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>(
      'RABBITMQ_URL',
      'amqp://guest:guest@localhost:5673',
    );

    this.connection = await connect(url);
    this.channel = await this.connection.createChannel();

    // Asserted, not assumed. `assertExchange` and `assertQueue` create these if
    // they are missing and are harmless if they already exist, so this app can
    // start before the publisher has ever run — otherwise a topic exchange with
    // no bound queue silently drops everything it receives.
    await this.channel.assertExchange(EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });
    await this.channel.assertQueue(LEASE_CREATED_QUEUE, { durable: true });
    await this.channel.bindQueue(
      LEASE_CREATED_QUEUE,
      EVENTS_EXCHANGE,
      LEASE_CREATED,
    );

    // One unacked message at a time, so a slow handler applies backpressure
    // rather than having the whole queue pushed into this process's memory.
    await this.channel.prefetch(1);

    this.connection.on('error', (error: Error) =>
      this.logger.error(`connection error: ${error.message}`),
    );
    this.connection.on('close', () => this.logger.warn('connection closed'));

    this.logger.log(
      `connected to ${url} — exchange "${EVENTS_EXCHANGE}", queue "${LEASE_CREATED_QUEUE}"`,
    );
  }

  getChannel(): Channel {
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not open');
    }
    return this.channel;
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
