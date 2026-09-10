/**
 * Inspect — and optionally replay — messages the worker rejected.
 *
 *   node scripts/dead-letters.mjs              # look, change nothing
 *   node scripts/dead-letters.mjs --replay     # put them back on the queue
 *   node scripts/dead-letters.mjs --purge      # throw them away for good
 *
 * Listing is the default on purpose. A rejected message is usually rejected for
 * a reason, and replaying one that is still broken just sends it straight back
 * here — so the useful first move is always to read it.
 */
import { connect } from 'amqplib';

const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5673';
const EXCHANGE = process.env.EVENT_EXCHANGE ?? 'jarvis.events';
const QUEUE = process.env.EVENT_QUEUE ?? 'DOCUMENT_WORKER_QUEUE';
const DEAD_QUEUE = `${QUEUE}_DEAD`;
const ROUTING_KEY = process.env.EVENT_ROUTING_KEY ?? 'lease.created';

const replay = process.argv.includes('--replay');
const purge = process.argv.includes('--purge');

/**
 * amqplib decodes an AMQP timestamp as `{ "!": "timestamp", value: <seconds> }`
 * rather than a Date, so printing it directly gives "[object Object]".
 */
function formatDeathTime(time) {
  if (!time) return '—';
  if (typeof time?.value === 'number') {
    return new Date(time.value * 1000).toISOString();
  }
  return String(time);
}

const connection = await connect(URL);
const channel = await connection.createConfirmChannel();

const { messageCount } = await channel.checkQueue(DEAD_QUEUE);
console.log(`${DEAD_QUEUE}: ${messageCount} message(s)\n`);

if (messageCount === 0) {
  await connection.close();
  process.exit(0);
}

if (purge) {
  const { messageCount: purged } = await channel.purgeQueue(DEAD_QUEUE);
  console.log(`purged ${purged} message(s) — gone for good`);
  await connection.close();
  process.exit(0);
}

let handled = 0;

// `get` one at a time rather than `consume`: this is a one-shot tool, and it
// must stop at the count it saw rather than sitting on the queue waiting for
// more to arrive.
for (let i = 0; i < messageCount; i += 1) {
  const message = await channel.get(DEAD_QUEUE, { noAck: false });
  if (!message) break;

  // RabbitMQ records why it was dead-lettered, and when, in `x-death`.
  const death = message.properties.headers?.['x-death']?.[0];
  const body = message.content.toString();

  console.log(`--- ${i + 1}/${messageCount} ---`);
  console.log(`  reason:   ${death?.reason ?? 'unknown'}`);
  console.log(`  original: ${death?.['routing-keys']?.join(', ') ?? '—'}`);
  console.log(`  died at:  ${formatDeathTime(death?.time)}`);
  console.log(`  body:     ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`);

  if (!replay) {
    // Put it back exactly where it was — this run only looked at it.
    channel.nack(message, false, true);
    continue;
  }

  const routingKey = death?.['routing-keys']?.[0] ?? ROUTING_KEY;
  channel.publish(EXCHANGE, routingKey, message.content, {
    persistent: true,
    contentType: message.properties.contentType,
    // `x-death` deliberately not carried over: this is a fresh attempt, and
    // keeping the old death record makes the next one harder to read.
  });
  await channel.waitForConfirms();
  channel.ack(message);
  handled += 1;
  console.log(`  → replayed to ${EXCHANGE} (${routingKey})`);
}

console.log(
  replay
    ? `\nreplayed ${handled} message(s)`
    : `\nlooked at ${messageCount} message(s), left where they were`,
);

/*
 * The channel is closed before the connection, and that order is load-bearing.
 * `ack` only writes a frame — it does not wait for the broker to see it — so
 * closing the connection straight after drops the unflushed acks on the floor
 * and the broker requeues every message this run thought it had removed.
 * Closing the channel flushes them first.
 */
await channel.close();
await connection.close();
