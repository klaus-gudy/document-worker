/**
 * Publishes a sample `lease.created` event.
 *
 *   node scripts/publish-lease-created.mjs
 *   node scripts/publish-lease-created.mjs --count 3
 *
 * Stands in for whatever really publishes these. It sends plain JSON to the
 * topic exchange — no framework envelope — which is exactly what the listener
 * is written to accept.
 */
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';

const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5673';
const EXCHANGE = 'jarvis.events';
const ROUTING_KEY = 'lease.created';

const countFlag = process.argv.indexOf('--count');
const count = countFlag === -1 ? 1 : Number(process.argv[countFlag + 1]) || 1;

const SAMPLES = [
  {
    tenant: { name: 'Hassan Said', email: 'hassan.said@example.com', phone: '+255754112233' },
    unit: { label: 'Z4', property: 'Likely Apartments', address: 'Buguruni, Dar es Salaam' },
    terms: { durationMonths: 6, monthlyRent: 190_000, currency: 'TZS' },
  },
  {
    tenant: { name: 'Juma Salehe', email: 'juma.salehe@example.com', phone: '+255712345678' },
    unit: { label: 'C1', property: 'Bahari Heights', address: 'Masaki, Dar es Salaam' },
    terms: { durationMonths: 12, monthlyRent: 650_000, currency: 'TZS' },
  },
  {
    tenant: { name: 'Neema Mwinyi', phone: '+255768990011' },
    unit: { label: 'B7', property: 'Kijitonyama Court', address: 'Kijitonyama, Dar es Salaam' },
    terms: { durationMonths: 24, monthlyRent: 1_250_000, currency: 'TZS' },
  },
];

function sampleEvent(index) {
  const sample = SAMPLES[index % SAMPLES.length];
  const start = new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + sample.terms.durationMonths);

  return {
    leaseId: `lease_${randomUUID().slice(0, 8)}`,
    organizationId: 'org_bahari_properties',
    tenant: sample.tenant,
    unit: sample.unit,
    terms: {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      ...sample.terms,
    },
    occurredAt: new Date().toISOString(),
  };
}

const connection = await connect(URL);
const channel = await connection.createConfirmChannel();

// Asserted here too, so the publisher works whether or not the listener has
// ever run. Both sides declaring is normal — it is idempotent while the
// arguments match.
await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

for (let i = 0; i < count; i += 1) {
  const event = sampleEvent(i);

  channel.publish(EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
    // Survives a broker restart, which a durable queue alone does not
    // guarantee for messages already sitting in it.
    persistent: true,
    contentType: 'application/json',
    type: ROUTING_KEY,
    timestamp: Date.now(),
  });

  console.log(`→ ${ROUTING_KEY}  ${event.leaseId}  ${event.tenant.name}`);
}

await channel.waitForConfirms();
await connection.close();
console.log(`published ${count} event(s) to "${EXCHANGE}"`);
