import { registerAs } from '@nestjs/config';

/**
 * Broker settings, as a namespaced config factory.
 *
 * `registerAs` rather than reaching for `ConfigService.get('RABBITMQ_URL')` at
 * each call site: the defaults live in one place, the shape is typed, and a
 * consumer injects `rabbitmqConfig.KEY` instead of remembering a string. It is
 * the pattern Nest's own config docs lead with for exactly this reason.
 */
export default registerAs('rabbitmq', () => ({
  url: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5682',

  /**
   * The exchange every event is published to. A *topic* exchange, so a future
   * listener can bind `lease.*` or `#` without anything here changing.
   *
   * Nothing publishes to a queue directly — publishers address this exchange,
   * and the bindings below decide which queues get a copy.
   */
  exchange: process.env.EVENT_EXCHANGE ?? 'jarvis.events',

  /**
   * **This worker's own mailbox.** Named for *who consumes*, deliberately in
   * caps, so it cannot be mistaken for the routing key beside it — the queue
   * and the event are different things, and naming the queue after the event
   * is what made them look like one.
   */
  queue: process.env.EVENT_QUEUE ?? 'DOCUMENT_WORKER_QUEUE',

  /**
   * **The event this worker listens for** — a label describing what happened,
   * not a destination. Lower-case dotted, matching the publisher's vocabulary.
   *
   * Configurable, with the caveat that it is a contract rather than a
   * preference: it must match what the publisher sends, character for
   * character. Get it wrong and nothing errors — the exchange simply routes the
   * message to no queue at all and drops it, which is the quietest possible
   * failure. Change it only alongside the publisher.
   */
  routingKey: process.env.EVENT_ROUTING_KEY ?? 'lease.created',

  /**
   * **The event this worker announces once a document is stored.** A separate
   * key from `routingKey` above, deliberately — this worker consumes one event
   * and produces a different one, and giving them the same name the moment
   * both existed would have made the direction of each message ambiguous from
   * the config alone.
   *
   * Nobody has to bind anything to hear it; an unbound routing key on a topic
   * exchange is a normal, silent no-op, not an error. It exists for whichever
   * publisher wants to know the render finished — matched back to its own
   * request by the `objectKey` it chose in the first place.
   */
  completionRoutingKey:
    process.env.EVENT_COMPLETION_ROUTING_KEY ?? 'document.stored',

  /**
   * Where rejected messages go instead of being destroyed.
   *
   * Derived from the main exchange rather than configured separately: the two
   * are one topology, and letting them be set independently is how you end up
   * with a dead-letter exchange nothing is actually pointed at.
   */
  deadLetterExchange: `${process.env.EVENT_EXCHANGE ?? 'jarvis.events'}.dlx`,

  /**
   * Where this worker's rejected messages are held. Derived from the queue name
   * rather than set separately, so the pair cannot drift apart.
   */
  deadLetterQueue: `${process.env.EVENT_QUEUE ?? 'DOCUMENT_WORKER_QUEUE'}_DEAD`,

  /**
   * How many unacked messages the broker may have in flight to this process.
   * One means a slow handler applies backpressure rather than having the whole
   * queue pushed into memory.
   */
  prefetch: Number(process.env.RABBITMQ_PREFETCH ?? 1),
}));
