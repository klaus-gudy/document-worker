import { randomUUID } from 'node:crypto';

/**
 * Where a generated document lives in the bucket.
 *
 * `organizations/<orgId>/<scope>/<scopeId>/<uuid><ext>` — matching the layout
 * the Jarvis app writes uploaded files to, so a generated contract and a
 * scanned one sit side by side and a key reads as a path someone could navigate
 * in the MinIO console:
 *
 *   organizations/clx1.../leases/clx4.../clx9abc.pdf
 *   organizations/clx1.../organization/clx7def.pdf
 *
 * Pure: no database, no network. The subject is two strings the requester sent,
 * and this worker does not check that they resolve to anything — the requester
 * has a database and has already done that.
 */

/**
 * The subject's segment in the key. Plural entity names, mirroring the app's
 * `lib/documents.ts`.
 *
 * A subject type this worker has never heard of is **not** an error: it is
 * lower-cased and used as-is, so the app can file against a new kind of thing
 * without a deploy here. Unknown types landing in a plausible path beats a
 * rejected request over a name mismatch.
 */
const KEY_SEGMENT: Record<string, string> = {
  ORGANIZATION: 'organization',
  PROPERTY: 'properties',
  UNIT: 'units',
  MEMBERSHIP: 'members',
  LEASE: 'leases',
  INVOICE: 'invoices',
  PAYMENT: 'payments',
};

export function buildObjectKey(input: {
  organizationId: string;
  subjectType: string;
  subjectId: string | null;
  extension: string;
}) {
  const type = input.subjectType.toUpperCase();

  const scope =
    type === 'ORGANIZATION' || !input.subjectId
      ? KEY_SEGMENT.ORGANIZATION
      : `${KEY_SEGMENT[type] ?? type.toLowerCase()}/${input.subjectId}`;

  // Named by a fresh uuid, never by `fileName`: two organizations both filing
  // `contract-L-7F3QA.pdf` must not overwrite one another, and a supplied name
  // can contain anything at all, `../` included. The name a person chose
  // travels on the event instead.
  return `organizations/${input.organizationId}/${scope}/${randomUUID()}${input.extension}`;
}
