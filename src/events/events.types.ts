/**
 * The wire contract between this worker and whatever asks it for a document.
 *
 * **Nothing here knows what a lease is.** The requester has already decided
 * what the document says — it sends finished HTML, and this worker turns HTML
 * into a stored PDF. That boundary is the whole design: a service that renders
 * documents needs no database, no schema mirror, and no opinion about tenancy
 * agreements. Invoices, receipts and notices travel the same queue with no new
 * code here.
 *
 * Dependency-free on purpose, so the publishing side can copy this file whole
 * and typecheck its messages against it.
 */

/** Consumed. */
export const DOCUMENT_REQUESTED = 'document.requested';
/** Published on success. */
export const DOCUMENT_GENERATED = 'document.generated';
/** Published on failure, including the final give-up. */
export const DOCUMENT_FAILED = 'document.failed';

/**
 * What a document is filed against, as far as this worker is concerned: two
 * strings that become path segments in the object key. It does not resolve
 * them, join on them, or check that they exist — that is the requester's job,
 * and it has a database to do it with.
 */
export type DocumentSubject = {
  /**
   * Matches Jarvis's `FileAssetSubject` values (`LEASE`, `INVOICE`, …), but is
   * deliberately typed as a plain string: a new subject on that side must not
   * require a deploy on this one.
   */
  type: string;
  /** Null for a document belonging to the organization itself. */
  id: string | null;
};

export type RenderOptions = {
  /** Printed at the foot of every page, with a page counter beside it. */
  footerText?: string;
  /** Defaults to A4. Any Playwright page format. */
  format?: string;
  landscape?: boolean;
  /** CSS lengths. Defaults to Jarvis's contract margins. */
  margin?: {
    top?: string;
    bottom?: string;
    left?: string;
    right?: string;
  };
};

/**
 * "Turn this into a PDF and put it somewhere."
 *
 * `html` is a **complete HTML document**, stylesheet inlined, placeholders
 * already substituted. It is rendered exactly as given — this worker adds no
 * markup and no CSS of its own, so what the requester previewed is what gets
 * printed, byte for byte. A remote stylesheet or image will simply not load;
 * the renderer waits for `load` and nothing here fetches across the network.
 */
export type DocumentRequestedEvent = {
  /**
   * The requester's own idempotency and correlation key. Echoed on every reply,
   * so a publisher can match a result to the thing it asked for without
   * guessing. This worker does not deduplicate on it — a durable queue plus
   * at-least-once delivery means the same request may legitimately arrive
   * twice, and the requester is the only side that knows whether the second
   * copy should replace the first.
   */
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  html: string;
  /** The name a person sees. The stored object is named by a uuid regardless. */
  fileName: string;
  render?: RenderOptions;
  /**
   * Opaque. Carried through untouched onto the reply, for whatever the
   * requester needs to correlate — an asset-type id, a lease reference, a user
   * to notify. This worker never reads it.
   */
  meta?: Record<string, unknown>;
};

/** "It is rendered, and here is where it lives." */
export type DocumentGeneratedEvent = {
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  /**
   * The path within the bucket — **not** a URL. A URL bakes today's endpoint
   * into whatever row this ends up on, and the move from MinIO to R2 becomes a
   * data migration rather than an environment variable.
   */
  objectKey: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  /** ISO 8601. */
  generatedAt: string;
  meta?: Record<string, unknown>;
};

export type DocumentFailureReason =
  'invalid-request' | 'render' | 'storage' | 'unknown';

/**
 * "It did not work."
 *
 * Published because the requester is the only side that can do anything about
 * it — show a Retry button, flag the lease, tell someone. A worker that failed
 * silently would leave a Contract tab spinning forever with nothing anywhere
 * saying why.
 */
export type DocumentFailedEvent = {
  requestId: string;
  organizationId: string;
  subject: DocumentSubject;
  reason: DocumentFailureReason;
  message: string;
  attempts: number;
  /** True once the worker has given up and dead-lettered the request. */
  final: boolean;
  /** ISO 8601. */
  failedAt: string;
  meta?: Record<string, unknown>;
};

export type DomainEvent = {
  [DOCUMENT_REQUESTED]: DocumentRequestedEvent;
  [DOCUMENT_GENERATED]: DocumentGeneratedEvent;
  [DOCUMENT_FAILED]: DocumentFailedEvent;
};

export type PublishedRoutingKey =
  typeof DOCUMENT_GENERATED | typeof DOCUMENT_FAILED;

/** What is wrong with a request, or null when nothing is. */
export function validateDocumentRequest(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'body is not an object';
  }

  const event = value as Partial<DocumentRequestedEvent>;
  const missing = (
    ['requestId', 'organizationId', 'html', 'fileName'] as const
  ).filter((field) => typeof event[field] !== 'string' || !event[field]);

  if (missing.length > 0) return `missing or empty: ${missing.join(', ')}`;

  if (
    typeof event.subject !== 'object' ||
    event.subject === null ||
    typeof event.subject.type !== 'string' ||
    !event.subject.type
  ) {
    return 'subject.type is required';
  }

  const subjectId = event.subject.id;
  if (subjectId !== null && typeof subjectId !== 'string') {
    return 'subject.id must be a string or null';
  }

  return null;
}
