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
  url: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5673',

  /** Topic exchange, so a second listener can bind `lease.*` without changes here. */
  exchange: process.env.EVENTS_EXCHANGE ?? 'jarvis.events',

  /**
   * Where rejected messages go instead of being destroyed.
   *
   * Derived from the main exchange rather than configured separately: the two
   * are one topology, and letting them be set independently is how you end up
   * with a dead-letter exchange nothing is actually pointed at.
   */
  deadLetterExchange: `${process.env.EVENTS_EXCHANGE ?? 'jarvis.events'}.dlx`,

  /**
   * How many unacked messages the broker may have in flight to this process.
   * One means a slow handler applies backpressure rather than having the whole
   * queue pushed into memory.
   */
  prefetch: Number(process.env.RABBITMQ_PREFETCH ?? 1),
}));
