/**
 * Names this module and its publisher have to agree on.
 *
 * Together in one file because they are a contract, not configuration: if the
 * routing key here and the one the publisher uses drift apart, nothing errors —
 * the message is delivered to nobody, which is the hardest kind of bug to see.
 */

/** The routing key this module listens for. */
export const LEASE_CREATED = 'lease.created';

/**
 * This listener's own queue.
 *
 * One queue per listener, never a shared one. Two listeners on the same queue
 * split the messages between them — each gets *some* — whereas two queues both
 * bound to `lease.created` each get their own copy, which is what "listening to
 * an event" is supposed to mean.
 */
export const LEASE_CREATED_QUEUE = 'contracts.lease-created';

/**
 * How a contract is laid out on the page. **Fixed, not configurable.**
 *
 * A stored contract is a record, and a record whose margins depend on what a
 * publisher happened to send is a record that cannot be reproduced. These
 * values are the house style: every contract this worker files is laid out
 * identically, and changing them is a deliberate edit here rather than a field
 * someone can set per message.
 *
 * `printBackground` is on because a document's own shading — a highlighted
 * figure, a filled table header — is content, not decoration. Without it every
 * coloured block prints white.
 */
export const CONTRACT_PDF_OPTIONS = {
  format: 'A4',
  printBackground: true,
  margin: {
    top: '20mm',
    right: '15mm',
    bottom: '20mm',
    left: '15mm',
  },
} as const;

/** Contracts are filed as PDFs; nothing else. */
export const CONTRACT_CONTENT_TYPE = 'application/pdf';
