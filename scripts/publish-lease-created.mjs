/**
 * Publishes a sample `lease.created` event.
 *
 *   node scripts/publish-lease-created.mjs
 *   node scripts/publish-lease-created.mjs --count 3
 *
 * Stands in for whatever really publishes these. It sends plain JSON to the
 * topic exchange — no framework envelope — which is exactly what the listener
 * is written to accept.
 *
 * The payload is deliberately just the finished HTML and the destination key:
 * the publisher owns the template and decides where a contract belongs, and the
 * worker only renders and uploads.
 */
import { connect } from 'amqplib';
import { randomUUID } from 'node:crypto';

const URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5673';
const EXCHANGE = process.env.EVENT_EXCHANGE ?? 'jarvis.events';
const ROUTING_KEY = process.env.EVENT_ROUTING_KEY ?? 'lease.created';

const countFlag = process.argv.indexOf('--count');
const count = countFlag === -1 ? 1 : Number(process.argv[countFlag + 1]) || 1;

const TENANTS = [
  { name: 'Asha Mushi', unit: 'Z4', property: 'Likely Apartments', rent: '500,000' },
  { name: 'Juma Salehe', unit: 'C1', property: 'Bahari Heights', rent: '650,000' },
  { name: 'Neema Mwinyi', unit: 'B7', property: 'Kijitonyama Court', rent: '1,250,000' },
];

function sampleEvent(index) {
  const tenant = TENANTS[index % TENANTS.length];
  const organizationId = 'org-123';
  const leaseId = `lease-${randomUUID().slice(0, 8)}`;
  const assetId = `asset-${randomUUID().slice(0, 8)}`;

  return {
    html:
      `<html><body>` +
      `<h1>Lease Agreement</h1>` +
      `<p>Tenant: ${tenant.name}</p>` +
      `<p>Unit: ${tenant.unit} at ${tenant.property}</p>` +
      `<p>Rent: TZS ${tenant.rent}</p>` +
      `</body></html>`,
    objectKey: `organizations/${organizationId}/leases/${leaseId}/contracts/${assetId}.pdf`,
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

  console.log(`→ ${ROUTING_KEY}  ${event.objectKey}`);
}

await channel.waitForConfirms();
await connection.close();
console.log(`published ${count} event(s) to "${EXCHANGE}"`);
