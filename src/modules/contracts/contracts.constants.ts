/**
 * Settings this module owns.
 *
 * The exchange, queue and routing key are **not** here — they describe how this
 * service is wired to the broker rather than what a contract is, so they live
 * in `config/rabbitmq.config.ts` and can be set per environment.
 */

/**
 * How a contract is laid out on the page. **Fixed here, never taken off a
 * message**: a stored contract is a record, and one laid out however the
 * publisher felt that day is one nobody can reproduce.
 *
 * The footer is the deliberate exception, and only its *text* — see
 * `FOOTER_TEXT_MAX` and `LeaseCreatedEvent.footerText`. Whether a footer is
 * drawn, where it sits and what it looks like are decided by `PdfService`;
 * the words in it are content the publisher owns.
 */
export const CONTRACT_PDF_OPTIONS = {
  format: 'A4',
  printBackground: true,
  /**
   * The measurements contracts were filed under before rendering moved here,
   * kept deliberately so a contract generated today lines up with one already
   * in the bucket. A page of a lease is read beside its predecessors.
   */
  margin: {
    top: '18mm',
    right: '16mm',
    bottom: '20mm',
    left: '16mm',
  },
} as const;

/**
 * Longest footer this service will print.
 *
 * Matches `RenderPdfDto`'s cap on the HTTP path deliberately. That route is
 * guarded by `ValidationPipe`; a queue message never passes through one, so
 * without this the two entry points to the same renderer would disagree about
 * what they accept — which is exactly the kind of difference nobody notices
 * until one of them is handed a runaway string. Truncated rather than
 * rejected: an over-long footer is a cosmetic problem, and refusing to file a
 * contract over one would be the larger failure.
 */
export const FOOTER_TEXT_MAX = 200;

/** Contracts are filed as PDFs; nothing else. */
export const CONTRACT_CONTENT_TYPE = 'application/pdf';
