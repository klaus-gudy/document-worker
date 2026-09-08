/**
 * The shape of a `lease.created` message.
 *
 * A plain type rather than a class with validation decorators: this arrives off
 * a queue, not out of an HTTP request, so Nest's `ValidationPipe` never sees it.
 * The listener checks what it needs and treats the rest as data.
 */
export type LeaseCreatedEvent = {
  leaseId: string;
  organizationId: string;
  tenant: {
    name: string;
    email?: string;
    phone?: string;
  };
  unit: {
    label: string;
    property: string;
    address?: string;
  };
  terms: {
    startDate: string;
    endDate: string;
    durationMonths: number;
    monthlyRent: number;
    currency: string;
  };
  /** ISO 8601. Lets a listener notice it is working through a backlog. */
  occurredAt: string;
};
