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
