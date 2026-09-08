import { Logger } from '@nestjs/common';

import { ContractsService } from './contracts.service';
import type { LeaseCreatedEvent } from './events/lease-created.event';

/**
 * The service is testable without a broker, which is the reason it is separate
 * from the listener at all — so these tests construct it directly. No
 * `Test.createTestingModule` either: it has no injected dependencies, and going
 * through the container would only add Nest's own bootstrap logging to the
 * output these assertions read.
 */
describe('ContractsService', () => {
  let service: ContractsService;
  let logged: string[];

  const event: LeaseCreatedEvent = {
    leaseId: 'lease_c6bd5b92',
    organizationId: 'org_bahari_properties',
    tenant: { name: 'Hassan Said', phone: '+255754112233' },
    unit: { label: 'Z4', property: 'Likely Apartments' },
    terms: {
      startDate: '2026-09-08',
      endDate: '2027-03-08',
      durationMonths: 6,
      monthlyRent: 190_000,
      currency: 'TZS',
    },
    occurredAt: '2026-09-08T06:21:08.122Z',
  };

  beforeEach(() => {
    logged = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => logged.push(String(message)));

    service = new ContractsService();
  });

  afterEach(() => jest.restoreAllMocks());

  it('summarises the lease in one readable line', () => {
    service.handleLeaseCreated(event);

    expect(logged[0]).toBe(
      'Hassan Said → Z4 at Likely Apartments, TZS 190,000/month for 6 months (lease lease_c6bd5b92)',
    );
  });

  it('prints the whole payload, so nothing that arrived is hidden', () => {
    service.handleLeaseCreated(event);

    expect(logged[1]).toContain('"leaseId": "lease_c6bd5b92"');
    expect(logged[1]).toContain('"phone": "+255754112233"');
  });

  it('does not throw on a payload missing the fields it summarises', () => {
    // A publisher is free to send a shape this app did not expect. Printing
    // something useful beats crashing the listener and dead-lettering the
    // message over a display concern.
    const sparse = { leaseId: 'lease_x' } as unknown as LeaseCreatedEvent;

    expect(() => service.handleLeaseCreated(sparse)).not.toThrow();
    expect(logged[0]).toContain('unknown tenant');
    expect(logged[0]).toContain('unknown rent');
  });
});
