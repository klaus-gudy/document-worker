import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import type { LeaseCreatedEvent } from './lease-created.event';
import { LEASE_CREATED, LEASE_CREATED_QUEUE } from './rabbitmq.constants';
import { RabbitmqService } from './rabbitmq.service';

/**
 * Listens for `lease.created` and prints what arrived.
 *
 * Starts on `onApplicationBootstrap` rather than `onModuleInit`, deliberately:
 * by then `RabbitmqService` has finished connecting and declaring its queue.
 * Consuming before that would throw on a channel that does not exist yet.
 */
@Injectable()
export class LeaseCreatedListener implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaseCreatedListener.name);

  constructor(private readonly rabbitmq: RabbitmqService) {}

  async onApplicationBootstrap() {
    const channel = this.rabbitmq.getChannel();

    await channel.consume(LEASE_CREATED_QUEUE, (message) => {
      // A null delivery means the consumer was cancelled broker-side — there is
      // nothing to ack and nothing to handle.
      if (!message) return;
      this.handle(message);
    });

    this.logger.log(
      `listening for "${LEASE_CREATED}" on "${LEASE_CREATED_QUEUE}"`,
    );
  }

  private handle(message: ConsumeMessage) {
    const channel = this.rabbitmq.getChannel();
    const raw = message.content.toString();

    let event: LeaseCreatedEvent;
    try {
      event = JSON.parse(raw) as LeaseCreatedEvent;
    } catch {
      /*
       * Rejected without requeueing. A body that is not JSON will not become
       * JSON on a second attempt, and `nack(requeue: true)` would put it
       * straight back at the head of the queue — this process would then spin
       * on it forever and every valid lease behind it would wait.
       */
      this.logger.error(
        `dropping message that is not JSON: ${raw.slice(0, 200)}`,
      );
      channel.nack(message, false, false);
      return;
    }

    this.display(event, message.fields.routingKey);

    // Acked only after the work is done. Until this line the broker still owns
    // the message, so a crash mid-handler means redelivery rather than loss.
    channel.ack(message);
  }

  /**
   * Prints the payload.
   *
   * A summary line first, then the whole body. The summary is what is actually
   * readable when these are scrolling past; the full JSON is there for when the
   * summary is not enough, which is the moment you would otherwise wish you had
   * logged it.
   */
  private display(event: LeaseCreatedEvent, routingKey: string) {
    const { tenant, unit, terms } = event;

    const rent =
      terms?.monthlyRent !== undefined
        ? `${terms.currency ?? ''} ${terms.monthlyRent.toLocaleString('en-US')}`.trim()
        : 'unknown rent';

    this.logger.log(
      `${routingKey} — ${tenant?.name ?? 'unknown tenant'} → ` +
        `${unit?.label ?? '?'} at ${unit?.property ?? '?'}, ` +
        `${rent}/month for ${terms?.durationMonths ?? '?'} months ` +
        `(lease ${event.leaseId})`,
    );

    // `log`, not `debug`: seeing the payload is the whole point of this
    // listener, and `debug` is filtered out at the default log level.
    this.logger.log(`payload:\n${JSON.stringify(event, null, 2)}`);
  }
}
