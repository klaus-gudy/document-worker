/**
 * The names this app and its publisher have to agree on.
 *
 * In one file because they are a contract, not configuration: if the exchange
 * here and the exchange the publisher uses drift apart, nothing errors — the
 * message is simply delivered to nobody, which is the hardest kind of bug to
 * see.
 */

/** A topic exchange, so more listeners can bind `lease.*` later without changes here. */
export const EVENTS_EXCHANGE = 'jarvis.events';

/** The routing key this app listens for. */
export const LEASE_CREATED = 'lease.created';

/**
 * This listener's own queue.
 *
 * One queue per listener, never a shared one. Two listeners on the same queue
 * split the messages between them — each gets *some* — whereas two queues both
 * bound to `lease.created` each get their own copy, which is what "listening to
 * an event" is supposed to mean.
 */
export const LEASE_CREATED_QUEUE = 'lease.created.listener';
