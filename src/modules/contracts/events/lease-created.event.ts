import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The shape of a `lease.created` message.
 *
 * **Classes rather than a plain `type`, purely so Swagger can see them.**
 * TypeScript types are erased at compile time; `@nestjs/swagger` reflects over
 * class metadata, so a `type` would leave the queue contract undocumented. The
 * runtime cost is nil — nothing here is instantiated, these are used as type
 * annotations on a `JSON.parse` result, which structural typing allows.
 *
 * There are deliberately **no `class-validator` decorators**. This arrives off a
 * queue, not out of an HTTP request, so Nest's `ValidationPipe` never runs
 * against it. Decorating it as if it validated would be a comforting lie; the
 * listener checks what it needs and treats the rest as data.
 */
export class LeaseTenant {
  @ApiProperty({ example: 'Hassan Said' })
  name: string;

  @ApiPropertyOptional({ example: 'hassan.said@example.com' })
  email?: string;

  @ApiPropertyOptional({ example: '+255754112233' })
  phone?: string;
}

export class LeaseUnit {
  @ApiProperty({ example: 'Z4' })
  label: string;

  @ApiProperty({ example: 'Likely Apartments' })
  property: string;

  @ApiPropertyOptional({ example: 'Buguruni, Dar es Salaam' })
  address?: string;
}

export class LeaseTerms {
  @ApiProperty({ example: '2026-09-08', description: 'ISO date' })
  startDate: string;

  @ApiProperty({ example: '2027-03-08', description: 'ISO date' })
  endDate: string;

  @ApiProperty({ example: 6 })
  durationMonths: number;

  @ApiProperty({ example: 190000, description: 'Minor-unit-free whole amount' })
  monthlyRent: number;

  @ApiProperty({ example: 'TZS', description: 'ISO 4217 code' })
  currency: string;
}

export class LeaseCreatedEvent {
  @ApiProperty({ example: 'lease_c6bd5b92' })
  leaseId: string;

  @ApiProperty({ example: 'org_bahari_properties' })
  organizationId: string;

  @ApiProperty({ type: LeaseTenant })
  tenant: LeaseTenant;

  @ApiProperty({ type: LeaseUnit })
  unit: LeaseUnit;

  @ApiProperty({ type: LeaseTerms })
  terms: LeaseTerms;

  @ApiProperty({
    example: '2026-09-08T06:21:08.122Z',
    description:
      'ISO 8601. Lets a listener notice it is working through a backlog.',
  })
  occurredAt: string;
}
