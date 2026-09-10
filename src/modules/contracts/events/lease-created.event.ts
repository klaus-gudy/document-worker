import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
 * `footerText` is the one field that is neither of those, and the line it sits
 * on is worth being precise about. **Page layout stays this service\'s** — see
 * `CONTRACT_PDF_OPTIONS` — because a record laid out however the publisher felt
 * that day is one nobody can reproduce. What goes *in* the footer is content:
 * a template name and a contract reference, which only the publisher knows and
 * this service could not invent without the domain model it deliberately does
 * not have.
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

  @ApiPropertyOptional({
    description:
      'Printed at the foot of every page, beside a page counter. Omitted, the ' +
      'document is rendered with no footer at all.',
    example: 'Standard tenancy agreement · L-LWX8G',
    maxLength: 200,
  })
  footerText?: string;

  @ApiPropertyOptional({
    description:
      'Anything the publisher wants handed back to it when the document is ' +
      'stored. Echoed verbatim on `document.stored` and never read, parsed or ' +
      'acted on here — it is opaque by design, which is what lets the ' +
      'publisher carry its own ids without this service learning what a lease ' +
      'is. Keep it small; it rides on every message and comes back on every ' +
      'completion.',
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
