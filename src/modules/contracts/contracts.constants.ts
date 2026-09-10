/**
 * Settings this module owns.
 *
 * The exchange, queue and routing key are **not** here — they describe how this
 * service is wired to the broker rather than what a contract is, so they live
 * in `config/rabbitmq.config.ts` and can be set per environment.
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
