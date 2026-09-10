import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Published once a document a `lease.created` message asked for is sitting in
 * the bucket.
 *
 * **This worker still holds no domain model.** It has no idea what a lease is
 * and never looks inside `meta` — that field is whatever the request carried,
 * handed straight back. Everything this service knows on its own is the four
 * fields below: where it put the bytes, what they are, how many, and when.
 *
 * `objectKey` is a correlation key in its own right and always present, so a
 * publisher that sends no `meta` can still match a completion to its request.
 * `meta` is for the publisher that would rather not re-derive anything.
 */
export class DocumentStoredEvent {
  @ApiProperty({
    description:
      'The same key the request specified. Matches it back to its own record.',
    example: 'organizations/org-123/leases/lease-456/contracts/asset-789.pdf',
  })
  objectKey: string;

  @ApiProperty({ example: 'application/pdf' })
  contentType: string;

  @ApiProperty({ example: 21467 })
  sizeBytes: number;

  @ApiProperty({
    example: '2026-09-11T09:14:02.000Z',
    description:
      'ISO 8601. When the object finished uploading, not when the message is read.',
  })
  storedAt: string;

  @ApiPropertyOptional({
    description:
      'Whatever `lease.created` carried in its own `meta`, returned untouched. ' +
      'Absent when the request carried none.',
    example: {
      organizationId: 'org-123',
      leaseId: 'lease-456',
      contractNumber: 'L-LWX8G',
      fileName: 'contract-L-LWX8G.pdf',
      missing: ['tenant_nidaNumber'],
    },
    type: 'object',
    additionalProperties: true,
  })
  meta?: Record<string, unknown>;
}
