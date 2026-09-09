import { ApiProperty } from '@nestjs/swagger';

/**
 * The shape of a `lease.created` message.
 *
 * **The publisher has already decided what the document says and where it
 * goes.** It sends finished HTML and the exact object key to store the result
 * under; this worker renders and uploads. Nothing here resolves a template,
 * reads a database, or invents a key — that keeps the worker free of any
 * domain model, and leaves the publisher as the only thing that owns where a
 * contract belongs.
 *
 * A class rather than a `type` so `@nestjs/swagger` can reflect over it —
 * TypeScript types are erased at compile time. There are deliberately no
 * `class-validator` decorators: this arrives off a queue, not an HTTP request,
 * so `ValidationPipe` never runs against it. `LeaseCreatedListener` checks it
 * by hand.
 */
export class LeaseCreatedEvent {
  @ApiProperty({
    description:
      'A complete HTML document, stylesheet inlined. Rendered exactly as ' +
      'given — nothing is added to it.',
    example:
      '<html><body><h1>Lease Agreement</h1><p>Tenant: Asha Mushi</p><p>Rent: TZS 500,000</p></body></html>',
  })
  html: string;

  @ApiProperty({
    description:
      'Where the rendered PDF is stored, as a path within the bucket. Chosen ' +
      'by the publisher, which is the side that knows what the document ' +
      'belongs to.',
    example: 'organizations/org-123/leases/lease-456/contracts/asset-789.pdf',
  })
  objectKey: string;
}
