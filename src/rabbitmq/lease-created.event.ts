/**
 * The shape of a `lease.created` message.
 *
 * A plain type rather than a class with decorators: nothing validates this at
 * the framework level, because the message comes off a queue rather than out of
 * an HTTP request. The listener checks what it needs and treats the rest as
 * data.
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
