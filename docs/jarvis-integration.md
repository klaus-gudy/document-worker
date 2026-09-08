# Moving Jarvis onto this worker

Jarvis is untouched. It still renders contracts in-process with Playwright and
writes the `FileAsset` row itself. This is what changes to hand the rendering to
`document-worker` — and what Jarvis gets to delete afterwards.

The shape of it: Jarvis keeps **one** worker process, but it no longer has a
browser. It translates `lease.created` into a `document.requested` (a database
read and a string substitution, both fast), and it consumes `document.generated`
to write the row. All database access stays on the Jarvis side, which is the
point of the split.

```
lease.created ──▶ [jarvis worker] ──▶ document.requested ──▶ [document-worker]
                       ▲                                            │
                       └──────────── document.generated ────────────┘
                       writes the FileAsset row
```

---

## 1. `lib/events/config.ts` — declare the new events

Add the three routing keys and their payload types. **Copy the types from
`document-worker/src/events/events.types.ts`** rather than retyping them; that
file is the contract, and the two must agree exactly.

```ts
export const EVENT_ROUTING_KEYS = [
  "lease.created",
  "document.requested",
  "document.generated",
  "document.failed",
] as const;

export type DocumentSubject = { type: string; id: string | null };

export type DocumentRequestedEvent = {
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  /** A complete HTML document — stylesheet inlined, placeholders substituted. */
  html: string;
  fileName: string;
  render?: {
    footerText?: string;
    format?: string;
    landscape?: boolean;
    margin?: { top?: string; bottom?: string; left?: string; right?: string };
  };
  /** Opaque to the worker; carried back untouched. */
  meta?: Record<string, unknown>;
};

export type DocumentGeneratedEvent = {
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  /** The path within the bucket. The object is already there. */
  objectKey: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  generatedAt: string;
  meta?: Record<string, unknown>;
};

export type DocumentFailedEvent = {
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  reason: "invalid-request" | "render" | "storage" | "unknown";
  message: string;
  attempts: number;
  /** True once the worker has given up. */
  final: boolean;
  failedAt: string;
  meta?: Record<string, unknown>;
};

export type DomainEvent = {
  "lease.created": LeaseCreatedEvent;
  "document.requested": DocumentRequestedEvent;
  "document.generated": DocumentGeneratedEvent;
  "document.failed": DocumentFailedEvent;
};

/** Where the worker picks requests up. Must match its `DOCUMENT_QUEUE`. */
export const DOCUMENT_QUEUE = process.env.DOCUMENT_QUEUE ?? "documents.generate";

/** Where Jarvis hears back. Its own queue, so a slow reader cannot block renders. */
export const DOCUMENT_RESULTS_QUEUE =
  process.env.DOCUMENT_RESULTS_QUEUE ?? "documents.results";
export const DOCUMENT_RESULTS_DLQ = `${DOCUMENT_RESULTS_QUEUE}.dead`;
export const DOCUMENT_RESULTS_BINDINGS = [
  "document.generated",
  "document.failed",
] as const;
```

## 2. `lib/events/publisher.ts` — declare both new queues

Inside `declareEventTopology`, after the existing contract queue:

```ts
  // Declared by the *producer* for the same reason `contracts.generate` is: a
  // request published before the worker has ever run must be held, and a topic
  // exchange with no bound queue drops what it receives without complaint.
  await channel.assertQueue(DOCUMENT_QUEUE, {
    durable: true,
    deadLetterExchange: EVENTS_DLX,
  });
  await channel.bindQueue(DOCUMENT_QUEUE, EVENTS_EXCHANGE, "document.requested");

  await channel.assertQueue(DOCUMENT_RESULTS_QUEUE, {
    durable: true,
    deadLetterExchange: EVENTS_DLX,
  });
  for (const binding of DOCUMENT_RESULTS_BINDINGS) {
    await channel.bindQueue(DOCUMENT_RESULTS_QUEUE, EVENTS_EXCHANGE, binding);
  }

  await channel.assertQueue(DOCUMENT_RESULTS_DLQ, { durable: true });
  await channel.bindQueue(DOCUMENT_RESULTS_DLQ, EVENTS_DLX, "");
```

> **These must agree with the worker's own declaration**, argument for argument.
> Both sides assert the topology because either may start first, and
> `assertQueue` is idempotent only while the arguments match — disagree about
> `durable` or the dead-letter exchange and whichever declares second gets
> `PRECONDITION_FAILED` and loses its channel.

## 3. `lib/contracts.ts` — ask instead of render

`generateAndStoreContract` becomes `requestContract`. Everything up to and
including `printableDocument` stays exactly as it is — that function is Jarvis's
definition of what a contract looks like on paper, and it belongs here. What goes
is `htmlToPdf` and `createDocument`.

```ts
import { randomUUID } from "node:crypto";
import { publishEvent } from "@/lib/events/publisher";

export type ContractRequestResult =
  | { ok: true; requestId: string; missing: string[] }
  | { ok: false; reason: "no-template" | "no-lease" | "publish"; message: string };

export async function requestContract(
  organizationId: string,
  leaseId: string
): Promise<ContractRequestResult> {
  let rendered = await generateLeaseContract(organizationId, leaseId);

  // Unchanged: an organization signing its first lease gets the standard
  // starter filed as its default, and this attempt carries on.
  if ("error" in rendered && rendered.error === "no-template") {
    const ensured = await ensureDefaultLeaseTemplate(organizationId);
    if (ensured) rendered = await generateLeaseContract(organizationId, leaseId);
  }

  if ("error" in rendered) {
    return rendered.error === "no-template"
      ? { ok: false, reason: "no-template", message: "This organization has no lease template." }
      : { ok: false, reason: "no-lease", message: "Lease not found in this organization." };
  }

  const { contract } = rendered;
  const requestId = randomUUID();

  const published = await publishEvent("document.requested", {
    requestId,
    organizationId,
    subject: { type: "LEASE", id: leaseId },
    // The same printable document that used to go straight to Chromium.
    html: printableDocument(contract.html),
    fileName: `contract-${contract.contractNumber}.pdf`,
    render: {
      footerText: `${contract.template.name} · ${contract.contractNumber}`,
    },
    // Everything the results consumer will need to file the row. It comes back
    // untouched, so nothing has to remember this request in the meantime.
    meta: {
      assetTypeId: LEASE_CONTRACT_TYPE_ID,
      contractNumber: contract.contractNumber,
      missing: contract.missing,
    },
  });

  return published.ok
    ? { ok: true, requestId, missing: contract.missing }
    : { ok: false, reason: "publish", message: published.error };
}
```

## 4. New `lib/document-results.ts` — file what came back

The object is **already in the bucket** — the worker put it there. So this is
not `createDocument`, which uploads first. It is the same checks with the upload
removed.

```ts
import { resolveAssetType } from "@/lib/asset-types";
import type { DocumentGeneratedEvent } from "@/lib/events/config";
import type { FileAssetSubject } from "@/lib/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { deleteObject } from "@/lib/storage";

const SUBJECT_COLUMN: Record<string, string> = {
  PROPERTY: "propertyId", UNIT: "unitId", MEMBERSHIP: "membershipId",
  LEASE: "leaseId", INVOICE: "invoiceId", PAYMENT: "paymentId",
};

/**
 * Records an object the document worker already stored.
 *
 * The tenancy checks are the same ones `createDocument` runs, and they are not
 * optional here just because another service did the writing: the worker takes
 * the subject on trust from the message, so this is where "does this lease
 * actually belong to this organization" is still answered.
 *
 * On any refusal the object is deleted rather than left — nothing will ever
 * point at it, and an orphan in the bucket is invisible and unfixable.
 */
export async function fileGeneratedDocument(event: DocumentGeneratedEvent) {
  const assetTypeId = event.meta?.assetTypeId;
  if (typeof assetTypeId !== "string") {
    await deleteObject(event.objectKey);
    return { error: "no-asset-type" as const };
  }

  const assetType = await resolveAssetType(event.organizationId, assetTypeId);
  if (!assetType || assetType.subject !== event.subject.type) {
    await deleteObject(event.objectKey);
    return { error: "asset-type-not-found" as const };
  }

  const column = SUBJECT_COLUMN[event.subject.type];

  // `allowsMultiple` is false on the contract type, so the previous one has to
  // go before the new one can land — row and object together.
  if (!assetType.allowsMultiple && event.subject.id && column) {
    const previous = await prisma.fileAsset.findFirst({
      where: { organizationId: event.organizationId, assetTypeId: assetType.id, [column]: event.subject.id },
      select: { id: true, objectKey: true },
    });
    if (previous) {
      await prisma.fileAsset.delete({ where: { id: previous.id } });
      await deleteObject(previous.objectKey);
    }
  }

  const document = await prisma.fileAsset.create({
    data: {
      objectKey: event.objectKey,
      fileName: event.fileName,
      fileType: event.fileType,
      sizeBytes: event.sizeBytes,
      assetTypeId: assetType.id,
      organizationId: event.organizationId,
      // Generated, not uploaded. The worker is not a person, and inventing a
      // membership for it would put a lie in every "uploaded by" line.
      uploadedById: null,
      ...(event.subject.id && column ? { [column]: event.subject.id } : {}),
    },
    select: { id: true },
  });

  return { document };
}
```

> **`objectKey` is `@unique`.** A duplicate delivery of the same
> `document.generated` will violate it — catch that and treat it as success, the
> row is already there. A duplicate *render* (same `requestId`, different key)
> is the case to deduplicate on `requestId` if you care; the previous-document
> deletion above already keeps only one contract per lease either way.

## 5. `worker/contract-worker.ts` — translate, and file the results

Same process, two consumers, **no browser**:

- `contracts.generate` → `requestContract(...)` instead of
  `generateAndStoreContract(...)`. The ack/retry logic is unchanged, and
  `no-template` / `no-lease` still ack rather than retry.
- `documents.results` → `fileGeneratedDocument(event)` for `document.generated`;
  log and ack for `document.failed` (its `final` flag says whether the worker
  will try again).

Then delete the Chromium half:

```
lib/pdf.ts                       delete
closePdfBrowser()                remove from the worker's shutdown
package.json  "playwright"       remove from dependencies
npx playwright install chromium  no longer a setup step
```

`worker/backfill-contracts.ts` needs **no change at all** — it publishes
`lease.created` and always did.

## 6. Environment

Jarvis needs nothing new beyond the two queue names (both defaulted). The worker
needs `EVENTS_EXCHANGE`, `DOCUMENT_QUEUE` and the four `STORAGE_*` values to
match Jarvis's — same broker, same bucket. It needs **no `DATABASE_URL`.**

## What Jarvis is left with

It keeps every database read and every database write, which is the whole reason
for the split. It loses a ~100MB browser from its dependency tree and its deploy
image, and gains a rendering service that will file an invoice or a notice the
day it is asked to, without knowing what one is.
