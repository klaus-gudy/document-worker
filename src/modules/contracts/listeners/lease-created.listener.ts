import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import { RabbitmqService } from '@/messaging/rabbitmq.service';
import {
  LEASE_CREATED,
  LEASE_CREATED_QUEUE,
} from '@/modules/contracts/contracts.constants';
import { ContractsService } from '@/modules/contracts/contracts.service';
import type { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';

/**
 * Receives `lease.created` off the queue and hands it to `ContractsService`.
 *
 * Deliberately thin — parse, delegate, ack. It is the same role a controller
 * plays for HTTP: everything it knows is about the transport, so the business
 * logic stays testable without a broker.
 *
 * Starts on `onApplicationBootstrap` rather than `onModuleInit`, because by
 * then `RabbitmqService` has finished connecting. Subscribing earlier would
 * throw on a channel that does not exist yet.
 */
@Injectable()
export class LeaseCreatedListener implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeaseCreatedListener.name);

  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly contracts: ContractsService,
  ) {}

  async onApplicationBootstrap() {
    await this.rabbitmq.subscribe(
      { queue: LEASE_CREATED_QUEUE, routingKeys: [LEASE_CREATED] },
      (message) => this.handle(message),
    );

    this.logger.log(
      `listening for "${LEASE_CREATED}" on "${LEASE_CREATED_QUEUE}"`,
    );
  }

  private handle(message: ConsumeMessage) {
    const raw = message.content.toString();

    let event: LeaseCreatedEvent;
    try {
      event = JSON.parse(raw) as LeaseCreatedEvent;
    } catch {
      // A body that is not JSON will not become JSON on a second attempt, so it
      // is rejected rather than requeued — see `RabbitmqService.reject`.
      this.logger.error(
        `dropping message that is not JSON: ${raw.slice(0, 200)}`,
      );
      this.rabbitmq.reject(message);
      return;
    }

    this.contracts.handleLeaseCreated(event);

    // Acked only after the work is done. Until this line the broker still owns
    // the message, so a crash mid-handler means redelivery rather than loss.
    this.rabbitmq.ack(message);
  }
}
