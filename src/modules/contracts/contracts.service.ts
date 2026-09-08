import { Injectable, Logger } from '@nestjs/common';

import type { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';

/**
 * What this application does when a lease is created.
 *
 * Separate from the listener on purpose. The listener is a transport adapter —
 * it knows about queues, JSON and acks; this knows about leases and nothing
 * else. Keeping the two apart is what lets this be called from an HTTP route or
 * a test without a broker anywhere near it, and it is the same reason a
 * controller stays thin and delegates to a service.
 *
 * Today it displays the payload. Whatever the real work becomes — rendering a
 * contract, notifying a tenant — belongs here, not in the listener.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  handleLeaseCreated(event: LeaseCreatedEvent) {
    const { tenant, unit, terms } = event;

    const rent =
      terms?.monthlyRent === undefined
        ? 'unknown rent'
        : `${terms.currency ?? ''} ${terms.monthlyRent.toLocaleString('en-US')}`.trim();

    // A summary first, because that is what is readable when these scroll past.
    this.logger.log(
      `${tenant?.name ?? 'unknown tenant'} → ${unit?.label ?? '?'} at ` +
        `${unit?.property ?? '?'}, ${rent}/month for ` +
        `${terms?.durationMonths ?? '?'} months (lease ${event.leaseId})`,
    );

    // `log`, not `debug`: seeing the payload is the whole point right now, and
    // `debug` is filtered out at the default log level.
    this.logger.log(`payload:\n${JSON.stringify(event, null, 2)}`);
  }
}
