import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';

import {
  describePayload,
  SEPARATOR,
  truncate,
} from '@/common/logging/log-format';
import rabbitmqConfig from '@/config/rabbitmq.config';
import { RabbitmqService } from '@/messaging/rabbitmq.service';
import { ContractsService } from '@/modules/contracts/contracts.service';
import type { DocumentStoredEvent } from '@/modules/contracts/events/document-stored.event';
import type { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';

/**
 * Receives `lease.created` off the queue and hands it to `ContractsService`.
 *
 * Deliberately thin — parse, delegate, ack. It is the same role a controller
 * plays for HTTP: everything it knows is about the transport, so the business
 * logic stays testable without a broker.
 *
 * **It also logs the delivery**, in the same bracketed form
 * `LoggingInterceptor` uses for HTTP. That has to happen here rather than in an
 * interceptor: this app talks to the broker through `amqplib` directly, not as
 * a Nest microservice, so no `ExecutionContext` is ever created for a message
 * and nothing in Nest's interceptor chain can see one.
 *
 * Starts on `onApplicationBootstrap` rather than `onModuleInit`, because by
 * then `RabbitmqService` has finished connecting. Subscribing earlier would
 * throw on a channel that does not exist yet.
 */
@Injectable()
export class LeaseCreatedListener implements OnApplicationBootstrap {
  private readonly logger = new Logger('AMQP');

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly contracts: ContractsService,
    @Inject(rabbitmqConfig.KEY)
    private readonly config: ConfigType<typeof rabbitmqConfig>,
  ) {}

  async onApplicationBootstrap() {
    await this.rabbitmq.subscribe(
      { queue: this.config.queue, routingKeys: [this.config.routingKey] },
      (message) => this.handle(message),
    );

    this.logger.log(
      `listening for "${this.config.routingKey}" on "${this.config.queue}"`,
    );
  }

  private async handle(message: ConsumeMessage) {
    const startedAt = Date.now();
    const { routingKey, redelivered, deliveryTag } = message.fields;
    const raw = message.content.toString();

    this.logger.log(`\n${SEPARATOR}`);
    this.logger.log(`[INCOMING MESSAGE] ${routingKey} → ${this.config.queue}`);
    this.logger.log(
      // `redelivered` is the one field here worth reading closely: true means
      // this exact message has been delivered before and something went wrong
      // last time, which is the difference between a new lease and a retry loop.
      `  delivery: ${deliveryTag}  redelivered: ${redelivered}  bytes: ${message.content.byteLength}`,
    );

    let event: LeaseCreatedEvent;
    try {
      event = JSON.parse(raw) as LeaseCreatedEvent;
    } catch {
      // A body that is not JSON will not become JSON on a second attempt, so it
      // is rejected rather than requeued — see `RabbitmqService.reject`.
      this.logger.error(`  raw: ${truncate(raw)}`);
      this.fail(routingKey, startedAt, 'body is not JSON — rejected');
      this.logger.error(`${SEPARATOR}\n`);

      this.rabbitmq.reject(message);
      return;
    }

    /*
     * The payload is logged without its `html`, which is the whole document and
     * would bury every other line. Its size is what actually matters here; the
     * rendered result is what anyone would inspect afterwards.
     */
    const { html, ...rest } = event;
    this.logger.log(
      `  payload: ${describePayload(rest)}  html: ${html?.length ?? 0} chars`,
    );

    const missing = this.missingFields(event);
    if (missing) {
      // Unprocessable rather than transient: a message with no HTML or no
      // destination will still have neither on a redelivery.
      this.fail(routingKey, startedAt, `${missing} — rejected`);
      this.logger.error(`${SEPARATOR}\n`);

      this.rabbitmq.reject(message);
      return;
    }

    let result: DocumentStoredEvent;
    try {
      result = await this.contracts.handleLeaseCreated(event);
    } catch (error) {
      /*
       * Rejected, not requeued. This queue has a dead-letter exchange bound to
       * it (see `RabbitmqService.subscribe`), so the message is held rather
       * than discarded — a person can inspect and replay it once whatever
       * failed (a bad payload, a MinIO outage) is fixed. The two causes are not
       * told apart here yet, so both currently take the same path.
       */
      this.fail(
        routingKey,
        startedAt,
        error instanceof Error ? error.message : String(error),
      );
      if (error instanceof Error && error.stack) this.logger.error(error.stack);
      this.logger.error(`${SEPARATOR}\n`);

      this.rabbitmq.reject(message);
      return;
    }

    /*
     * Announced before the ack, not after — but its own failure does not
     * reject the message. The document is already safely in the bucket by
     * this point; requeueing it because nobody heard about it would re-render
     * and re-upload a file that already exists, which is strictly worse than
     * the announcement simply being missed once. `RabbitmqService.publish`
     * already logs its own failure, so nothing here needs to.
     */
    this.rabbitmq.publish(this.config.completionRoutingKey, result);

    this.logger.log(
      `[PROCESSED] ${routingKey} +${Date.now() - startedAt}ms — acked, ` +
        `announced on "${this.config.completionRoutingKey}"`,
    );
    this.logger.log(`${SEPARATOR}\n`);

    // Acked only after the work is done. Until this line the broker still owns
    // the message, so a crash mid-render means redelivery rather than a lease
    // whose contract was never filed.
    this.rabbitmq.ack(message);
  }

  /** What the message is missing, as a sentence, or null when it is complete. */
  private missingFields(event: LeaseCreatedEvent): string | null {
    const missing = (['html', 'objectKey'] as const).filter(
      (field) => typeof event[field] !== 'string' || event[field].length === 0,
    );

    return missing.length > 0
      ? `missing or empty: ${missing.join(', ')}`
      : null;
  }

  /** The `[ERROR]` half of the bracket. Closing rule left to the caller. */
  private fail(routingKey: string, startedAt: number, reason: string) {
    this.logger.error(
      `[ERROR] ${routingKey} +${Date.now() - startedAt}ms — ${reason}`,
    );
  }
}
