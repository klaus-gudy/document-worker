import { randomUUID } from 'node:crypto';

/**
 * Where a generated document lives in the bucket:
 * `<category>/<subjectId>/<uuid><extension>`.
 *
 * Pure — no network, no side effects — so whatever eventually generates a
 * document (a contract render, an export, anything) can compute its own key
 * before uploading. Named by a fresh uuid rather than anything caller-supplied:
 * two documents for the same subject must not be able to overwrite one another,
 * and a caller-chosen name can contain anything at all, `../` included.
 */
export function buildObjectKey(input: {
  /** Groups documents by kind — e.g. "contracts", "invoices". */
  category: string;
  /** What the document is about. Omit for one with no single owner. */
  subjectId?: string;
  /** Include the dot: ".pdf", not "pdf". */
  extension: string;
}) {
  const segments = [input.category, input.subjectId].filter(Boolean);
  return `${segments.join('/')}/${randomUUID()}${input.extension}`;
}
