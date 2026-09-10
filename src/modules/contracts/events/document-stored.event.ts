import { ApiProperty } from '@nestjs/swagger';

/**
 * Published once a document a `lease.created` message asked for is sitting in
 * the bucket. There is no domain identifier on it — no lease id, no
 * organization id — because none was ever given: the request that started
 * this only carried `html` and `objectKey`, and this worker cannot echo back
 * what it was never told. `objectKey` is the correlation key, and it already
 * is one — the publisher chose it, so it already knows what the key means.
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
}
