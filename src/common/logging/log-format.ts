/**
 * Shared formatting for the request/message logs.
 *
 * Extracted so the HTTP interceptor and the queue listener produce the *same*
 * shape. They log different things — one a request, one a delivery — but a
 * reader scanning the terminal should not have to learn two layouts, and two
 * private copies of "how wide is the rule" drift apart the first time either is
 * touched.
 */

/** The visual rule that brackets one request or one delivery in the log. */
export const SEPARATOR =
  '-------------------------------------------------------------------------------------------------------------------';

/**
 * Payload keys whose values never belong in a log, matched at any depth.
 *
 * Payloads only — headers and AMQP properties are not logged wholesale, so
 * `authorization` and `cookie` are here for the case where one turns up
 * *inside* a body rather than to cover the header of the same name.
 */
const REDACTED_KEYS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accesskeyid',
  'secretaccesskey',
  'apikey',
];

/**
 * How much of a payload to print.
 *
 * The PDF endpoint accepts up to 5,000,000 characters of HTML, and a queue
 * message has no size limit this app enforces at all. Printing either in full
 * would not be a log line, it would be a denial of service against whoever is
 * reading the terminal.
 */
export const MAX_PAYLOAD_CHARS = 800;

/** Replaces the value of any sensitive-looking key, at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      REDACTED_KEYS.includes(key.toLowerCase()) ? '[REDACTED]' : redact(entry),
    ]),
  );
}

/** Cuts a string to `MAX_PAYLOAD_CHARS`, saying how much was left out. */
export function truncate(value: string, max = MAX_PAYLOAD_CHARS): string {
  return value.length > max
    ? `${value.slice(0, max)}… (${value.length} chars total)`
    : value;
}

/** A payload as one redacted, truncated line. */
export function describePayload(value: unknown): string {
  return truncate(JSON.stringify(redact(value)));
}
