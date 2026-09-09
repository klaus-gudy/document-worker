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

import type { DependencyHealth } from '@/common/dependency-health';
import { withTimeout } from '@/common/dependency-health';
import rabbitmqConfig from '@/config/rabbitmq.config';

/** Where a queue's rejected messages are held. */
export function deadLetterQueueOf(queue: string) {
  return `${queue}.dead`;
}

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

  /**
   * Tracked separately from `connection` being set, because the field stays
   * populated after the socket dies — nothing here nulls it out on close.
   * This is the flag `checkHealth` trusts first, before ever touching the
   * channel.
   */
  private connected = false;

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

    this.connection.on('error', (error: Error) => {
      this.connected = false;
      this.logger.error(`connection error: ${error.message}`);
    });
    this.connection.on('close', () => {
      this.connected = false;
      this.logger.warn('connection closed');
    });

    this.connected = true;
    this.logger.log(
      `connected to ${this.config.url} — exchange "${this.config.exchange}"`,
    );
  }

  /**
   * Is the broker actually reachable right now.
   *
   * There is currently **no reconnect logic** in this service — a dropped
   * connection stays dropped until the process restarts. That is exactly why
   * this exists: without it, that failure is invisible to everything outside
   * this process. `checkExchange` is used as the probe because it is a
   * read-only round trip against something already known to exist (asserted
   * at startup), so a healthy broker answers it with no side effect.
   */
  async checkHealth(): Promise<DependencyHealth> {
    if (!this.connected || !this.channel) {
      return { status: 'down', error: 'not connected' };
    }

    const startedAt = Date.now();
    try {
      await withTimeout(this.channel.checkExchange(this.config.exchange), 2000);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        status: 'down',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
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
    handler: (message: ConsumeMessage) => void | Promise<void>,
  ): Promise<string> {
    const channel = this.getChannel();
    const deadLetterQueue = deadLetterQueueOf(subscription.queue);

    /*
     * The holding area, declared before the queue that points at it. A
     * dead-letter exchange with no queue bound behaves exactly like having none
     * at all — the broker publishes the rejected message, nothing is listening,
     * and it is dropped just as silently.
     *
     * `direct`, not `fanout`: every listener's rejects come through this one
     * exchange, and a fanout would copy each one into *every* dead queue. The
     * routing key is the originating queue's own name, so each listener's
     * failures land only in its own holding area.
     */
    await channel.assertExchange(this.config.deadLetterExchange, 'direct', {
      durable: true,
    });
    await channel.assertQueue(deadLetterQueue, { durable: true });
    await channel.bindQueue(
      deadLetterQueue,
      this.config.deadLetterExchange,
      subscription.queue,
    );

    await this.assertWorkQueue(subscription.queue);

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

        /*
         * A handler is allowed to be async, and `consume` cannot await it — so
         * a rejected promise would otherwise surface as an unhandled rejection
         * and, depending on the Node flags, take the process down. Listeners
         * are expected to catch their own failures; this is the net under that,
         * not a substitute for it, and it leaves the message unacked rather
         * than guessing whether to ack or reject on the listener's behalf.
         */
        const result = handler(message);
        if (result instanceof Promise) {
          result.catch((error: unknown) =>
            this.logger.error(
              `unhandled error from the ${subscription.queue} handler: ` +
                (error instanceof Error ? error.message : String(error)),
            ),
          );
        }
      },
    );

    this.logger.log(
      `rejects from "${subscription.queue}" are held in "${deadLetterQueue}"`,
    );

    return consumerTag;
  }

  /**
   * Declares the work queue, with its rejects routed to the holding area.
   *
   * **A queue's settings are fixed at creation and cannot be edited.** If one
   * already exists with different settings — which is exactly what happens the
   * first time this runs against a broker that knew the queue *before* it had a
   * dead-letter exchange — the broker refuses with `PRECONDITION_FAILED` and
   * closes the channel. Nothing is silently reconfigured, and nothing is
   * silently lost; it simply will not start until someone decides what to do
   * with the old queue. The catch below turns that into a sentence a person can
   * act on rather than a bare AMQP code.
   */
  private async assertWorkQueue(queue: string) {
    try {
      await this.getChannel().assertQueue(queue, {
        durable: true,
        deadLetterExchange: this.config.deadLetterExchange,
        // Routed by the queue's own name so its rejects are told apart from
        // every other listener's on the shared dead-letter exchange.
        deadLetterRoutingKey: queue,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (message.includes('PRECONDITION_FAILED')) {
        this.logger.error(
          `queue "${queue}" already exists with different settings — almost ` +
            `certainly from before it had a dead-letter exchange. A queue ` +
            `cannot be reconfigured in place: drain it, delete it, and let ` +
            `this service recreate it.\n` +
            `  docker exec <broker> rabbitmqctl delete_queue ${queue}`,
        );
      }

      throw cause;
    }
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
