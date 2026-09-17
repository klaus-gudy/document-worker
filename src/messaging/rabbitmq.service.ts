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
import { redactUrl } from '@/common/logging/log-format';
import rabbitmqConfig from '@/config/rabbitmq.config';

/** What a feature module needs to declare to receive its events. */
export type Subscription = {
  /** The queue this listener owns. One queue per listener, never shared. */
  queue: string;
  /** Routing keys to bind it to on the exchange. */
  routingKeys: string[];
};

/** A subscription plus its handler, kept so a reconnect can replay it. */
type RegisteredSubscription = {
  subscription: Subscription;
  handler: (message: ConsumeMessage) => void | Promise<void>;
};

/** First reconnect delay, doubling up to {@link MAX_RECONNECT_DELAY_MS}. */
const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * Ceiling on the reconnect delay. Half a minute is long enough that a broker
 * that is down for hours is not dialled thousands of times, and short enough
 * that nobody watching a recovered broker waits meaningfully for this process
 * to notice.
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * An error as one line worth logging.
 *
 * `error.message` alone is not enough for the failure this matters most for: a
 * refused connection arrives as an `AggregateError` whose own message is the
 * empty string, one entry per address tried, so the log read
 * `could not connect to …:` and stopped. Falls back to the error `code`, then
 * the nested causes, then the constructor name — anything rather than a blank.
 */
function describeError(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);

  if (cause.message) return cause.message;

  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'string') return code;

  const errors = (cause as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((error) => describeError(error)).join('; ');
  }

  return cause.name;
}

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
 *
 * **It reconnects.** A failed first connection used to reject out of
 * `onModuleInit` as an unhandled rejection and take the process down — which
 * is exactly what happened on Railway, where the service started before its
 * `RABBITMQ_URL` was set and crash-looped against `localhost`. A broker that is
 * down at boot, or that goes away later, is now a retry with backoff rather
 * than an exit: boot continues, `checkHealth` reports `down` meanwhile, and
 * every subscription is replayed once the connection is back.
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

  /**
   * Every subscription ever registered, replayed after each reconnect.
   *
   * A queue, its bindings and its consumer live on a *channel*, so all three
   * die with the connection and none of them come back on their own. Without
   * this the process would reconnect and then sit there consuming nothing,
   * which is worse than crashing because it looks healthy.
   */
  private readonly subscriptions: RegisteredSubscription[] = [];

  /**
   * Which channel each in-flight delivery arrived on.
   *
   * Acking on a *different* channel than the one that delivered the message is
   * a protocol error (`unknown delivery tag`), and the broker's answer is to
   * close that channel — so a message handled across a reconnect would take
   * down the fresh connection as it completed. A `WeakMap` because the entry
   * is only interesting for as long as the caller still holds the message.
   */
  private readonly deliveryChannels = new WeakMap<ConsumeMessage, Channel>();

  /** Consecutive failed attempts, reset once a connection is fully set up. */
  private reconnectAttempts = 0;

  private reconnectTimer?: NodeJS.Timeout;

  /** Set by shutdown, so a deliberate close is not treated as an outage. */
  private closing = false;

  constructor(
    @Inject(rabbitmqConfig.KEY)
    private readonly config: ConfigType<typeof rabbitmqConfig>,
  ) {}

  /**
   * Makes one connection attempt and *does not* fail the boot if it loses.
   *
   * Awaited rather than fired off, so that when the broker is up — the normal
   * case, and what the e2e suite assumes — the connection and its exchange are
   * ready before any listener's `onApplicationBootstrap` runs, exactly as
   * before. When it loses, the retry continues in the background.
   */
  async onModuleInit() {
    await this.openConnection();
  }

  /**
   * Opens the connection, asserts the exchange, and replays subscriptions.
   *
   * Every failure path lands in {@link scheduleReconnect} rather than throwing:
   * this is called from `onModuleInit` and from a timer, and in neither place
   * is there a caller who could do anything useful with the error.
   */
  private async openConnection(): Promise<void> {
    if (this.closing) return;

    try {
      const connection = await connect(this.config.url);
      const channel = await connection.createChannel();

      // Asserted, not assumed. Idempotent while the arguments match, so this
      // app can start before the publisher has ever run — otherwise a topic
      // exchange with no bound queue silently drops everything it receives.
      await channel.assertExchange(this.config.exchange, 'topic', {
        durable: true,
      });
      await channel.prefetch(this.config.prefetch);

      connection.on('error', (error: Error) => {
        // Logged only: 'close' always follows, and that is where the reconnect
        // is scheduled, so handling it here too would dial twice.
        this.logger.error(`connection error: ${error.message}`);
      });
      connection.on('close', () => this.handleConnectionClose());

      /*
       * A channel can die on its own — `PRECONDITION_FAILED` from a queue whose
       * settings changed is the common one — and the connection stays up
       * around it, leaving this service holding a channel it cannot use. The
       * connection is closed deliberately so the single reconnect path below
       * rebuilds both rather than having a second repair route for channels.
       */
      channel.on('error', (error: Error) =>
        this.logger.error(`channel error: ${error.message}`),
      );
      channel.on('close', () => {
        if (this.closing || this.channel !== channel) return;
        this.logger.warn('channel closed — dropping the connection with it');
        void connection.close().catch(() => undefined);
      });

      this.connection = connection;
      this.channel = channel;
      this.connected = true;

      await this.replaySubscriptions();

      this.reconnectAttempts = 0;
      this.logger.log(
        `connected to ${redactUrl(this.config.url)} — ` +
          `exchange "${this.config.exchange}"`,
      );
    } catch (cause) {
      this.connected = false;
      this.logger.error(
        `could not connect to ${redactUrl(this.config.url)}: ` +
          describeError(cause),
      );
      this.scheduleReconnect();
    }
  }

  /** Re-declares every registered subscription on the current channel. */
  private async replaySubscriptions(): Promise<void> {
    for (const registered of this.subscriptions) {
      await this.startSubscription(registered);
    }
  }

  private handleConnectionClose() {
    // A close this service asked for, during shutdown, is not an outage.
    if (this.closing) return;

    this.connected = false;
    this.connection = undefined;
    this.channel = undefined;
    this.logger.warn('connection closed');
    this.scheduleReconnect();
  }

  /**
   * Queues the next attempt, backing off exponentially.
   *
   * Guarded against overlapping timers because both the connection's `close`
   * event and a failed attempt can land here for the same outage.
   */
  private scheduleReconnect() {
    if (this.closing || this.reconnectTimer) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;

    this.logger.warn(`reconnecting in ${Math.round(delay / 1000)}s`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openConnection();
    }, delay);
    // Nothing should be held open by a pending retry: without this the process
    // would refuse to exit while waiting to redial a broker that is gone.
    this.reconnectTimer.unref();
  }

  /**
   * Is the broker actually reachable right now.
   *
   * A dropped connection is retried in the background, so this answering
   * `down` means "not connected *yet*" rather than "not connected until
   * someone restarts this". `checkExchange` is the probe because it is a
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
   * Publishes one event onto the exchange, for anything bound to hear it.
   *
   * Fire-and-forget on purpose — this channel is never put into confirm mode,
   * so a successful call means the broker accepted the frame, not that a
   * queue received a copy. That is deliberately the same guarantee every
   * consumer of this method already lives with for its own delivery: this app
   * publishes nothing that anything downstream currently blocks on, so the
   * cost of upgrading to publisher confirms has no buyer yet. Revisit if that
   * changes.
   *
   * The boolean `channel.publish` returns is a *backpressure* signal — `false`
   * means the channel's internal write buffer is full, not that the message
   * was lost — so it is logged, not treated as failure.
   */
  publish(routingKey: string, payload: unknown) {
    const ok = this.getChannel().publish(
      this.config.exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { contentType: 'application/json', persistent: true },
    );

    if (!ok) {
      this.logger.warn(
        `publish to "${routingKey}" reported backpressure — the channel's write buffer is full`,
      );
    }
  }

  /**
   * Registers a listener and, when the broker is reachable, starts delivering.
   *
   * The registration is kept regardless, so a listener that subscribes while
   * the broker is down is not silently dropped — it starts consuming as part
   * of the next successful connection, along with every other subscription.
   *
   * The queue is durable and the binding is re-asserted on every connection,
   * so a message published while this process was down is waiting when it
   * returns rather than having been dropped.
   */
  async subscribe(
    subscription: Subscription,
    handler: (message: ConsumeMessage) => void | Promise<void>,
  ): Promise<void> {
    const registered: RegisteredSubscription = { subscription, handler };
    this.subscriptions.push(registered);

    if (!this.connected) {
      this.logger.warn(
        `not connected — "${subscription.queue}" will start consuming once the broker is back`,
      );
      return;
    }

    await this.startSubscription(registered);
  }

  /** Declares one subscription's topology and starts its consumer. */
  private async startSubscription({
    subscription,
    handler,
  }: RegisteredSubscription): Promise<void> {
    const channel = this.getChannel();
    const deadLetterQueue = this.config.deadLetterQueue;

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

    await channel.consume(subscription.queue, (message) => {
      // A null delivery means the consumer was cancelled broker-side — there
      // is nothing to ack and nothing to handle.
      if (!message) return;

      // Remembered before the handler runs: `ack`/`reject` need the channel
      // this arrived on, which may not be the current one by the time they
      // are called.
      this.deliveryChannels.set(message, channel);

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
    });

    this.logger.log(
      `rejects from "${subscription.queue}" are held in "${deadLetterQueue}"`,
    );
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
    this.settle(message, 'ack', (channel) => channel.ack(message));
  }

  /**
   * Rejects without requeueing.
   *
   * `requeue: true` is deliberately not offered: a rejected message put back at
   * the head of the queue is redelivered immediately, so this process would
   * spin on it forever and every valid message behind it would wait.
   */
  reject(message: ConsumeMessage) {
    this.settle(message, 'reject', (channel) =>
      channel.nack(message, false, false),
    );
  }

  /**
   * Acks or rejects on the channel the message was delivered on.
   *
   * A message whose channel is gone — the connection dropped while the handler
   * was working — is **already back on the queue**: the broker requeues
   * everything unacked when a channel closes. Settling it here would be a
   * protocol error against the new channel and would close that one too, so
   * this says so and stops. The redelivery is handled like any other, and the
   * `redelivered` flag in the listener's log is what shows it happened.
   */
  private settle(
    message: ConsumeMessage,
    action: 'ack' | 'reject',
    settle: (channel: Channel) => void,
  ) {
    const channel = this.deliveryChannels.get(message);

    if (!channel || channel !== this.channel) {
      this.logger.warn(
        `cannot ${action} delivery ${message.fields.deliveryTag} — its channel ` +
          `is gone, so the broker has already requeued it`,
      );
      return;
    }

    settle(channel);
    this.deliveryChannels.delete(message);
  }

  /**
   * Closes the channel then the connection, in that order.
   *
   * Without this, SIGTERM drops the socket mid-message and the broker waits out
   * a timeout before redelivering. Closing properly hands anything unacked back
   * immediately.
   */
  async onApplicationShutdown() {
    // Set first: it stops the close handlers below from reading a deliberate
    // shutdown as an outage and scheduling a reconnect on the way out.
    this.closing = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    try {
      await this.channel?.close();
      await this.connection?.close();
      this.logger.log('connection closed cleanly');
    } catch {
      // Already closing, or the socket is gone. Nothing left to close.
    } finally {
      this.connected = false;
      this.channel = undefined;
      this.connection = undefined;
    }
  }
}
