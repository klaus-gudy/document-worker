# document-worker

Turns HTML into a stored PDF. That is the whole job.

```
document.requested ──▶ documents.generate ──▶ [ HTML → PDF → object storage ] ──▶ document.generated
     (requester)            (queue)                    (this worker)                  (requester)
```

It has **no database**. The requester has already decided what the document
says — it sends finished HTML, and this renders it, stores the bytes, and
publishes the key they landed under. Whatever record that key belongs on is the
requester's business, and the requester is the only thing that writes to its own
tables.

That boundary is deliberate, and it is what makes this service reusable: it
knows nothing about leases, so invoices, receipts and notices travel the same
queue with no new code here.

## Why it is a separate service

**Chromium.** The PDF is rendered by a real browser so that what is filed is
byte-for-byte the document that was approved in a preview — the same stylesheet,
not a re-implementation of it. A layout engine that re-implements CSS produces
something *similar*, and then the stored PDF and the preview disagree and nobody
can say which is right. That costs a ~100MB browser and the memory to run it,
and keeping the only caller here means the app never has to have one installed.

**And it must not be able to fail the thing that asked.** The requester commits
its own work, puts a request on the bus, and whatever happens next happens on its
own time. A worker that is down for an hour becomes an hour's delay, not an hour
of missing documents, because the queue is durable.

## The contract

Full types, with the reasoning, in
[`src/events/events.types.ts`](src/events/events.types.ts) — copy that file into
the requester to typecheck against it.

**`document.requested`** — what you send:

```jsonc
{
  "requestId": "req_01J...",        // yours; echoed on every reply
  "organizationId": "clx1...",
  "subject": { "type": "LEASE", "id": "clx4..." },   // becomes the object-key path
  "html": "<!doctype html>…",       // COMPLETE document, CSS inlined, tokens already filled
  "fileName": "contract-L-7F3QA.pdf",
  "render": { "footerText": "Standard tenancy agreement · L-7F3QA" },
  "meta": { "assetTypeId": "sys_LEASE_CONTRACT" }    // opaque; carried back untouched
}
```

**`document.generated`** — what comes back:

```jsonc
{
  "requestId": "req_01J...",
  "organizationId": "clx1...",
  "subject": { "type": "LEASE", "id": "clx4..." },
  "objectKey": "organizations/clx1.../leases/clx4.../9f8e....pdf",
  "fileName": "contract-L-7F3QA.pdf",
  "fileType": "application/pdf",
  "sizeBytes": 92637,
  "generatedAt": "2026-09-02T00:00:00.000Z",
  "meta": { "assetTypeId": "sys_LEASE_CONTRACT" }
}
```

**`document.failed`** carries `reason`, `message`, `attempts` and `final`. It is
published on *every* failed attempt, not only the last: a document about to be
retried and one that has been abandoned need to look different to whoever is
waiting, and only this worker knows which is which.

Three things worth knowing about the shape:

- **`html` is rendered exactly as given.** No markup or CSS is added. It arrives
  as a string with no origin, so there is nothing for a `fetch` in it to be
  same-origin with and nothing remote will load. Sanitizing the markup is the
  requester's job, before it gets here.
- **`meta` is opaque and round-trips untouched.** It is how the requester knows
  which row a result belongs on without keeping its own table of pending renders.
- **`objectKey` is a path, not a URL.** A URL bakes today's endpoint into
  whatever row it lands on, and the move from MinIO to R2 becomes a data
  migration rather than an environment variable.

## Delivery guarantees, plainly

At-least-once, and **this worker does not deduplicate**. A durable queue means
the same `requestId` may legitimately arrive twice, and only the requester knows
whether the second render should replace the first or be discarded — so decide
that on `document.generated`, keyed on `requestId`.

| Outcome | What happens | Why |
| --- | --- | --- |
| Rendered and stored | ack, publish `document.generated` | — |
| Unparseable body | dead-letter, no reply | Will never become parseable, and there is no `requestId` to address a reply to. |
| Invalid request | dead-letter, reply if it has a `requestId` | Missing `html` will still be missing on a retry. |
| Render or storage failure | retry once, then dead-letter | Usually transient (a browser that died, a bucket that blinked). Anything that fails twice is not, and requeueing forever would spin this process on one poisoned message while every later request waits behind it. |
| Stored, but `document.generated` could not be published | **withdraw the object**, then retry | An object nobody was told about is invisible to the requester and impossible for it to clean up. Re-rendering is cheap next to a bucket filling with documents no row points at. |

The retry is a **republish carrying an `x-attempts` header**, not
`nack(requeue: true)`: a requeued delivery looks brand new, so the counter would
reset and the retry would never terminate.

## Running it

Needs a RabbitMQ and an S3-compatible bucket. Locally both come from Jarvis's
compose file:

```bash
cd ../jarvis && docker compose up -d
cd ../document-worker

cp .env.example .env
npm install
npm run playwright:install   # the browser, once per host

npm run start:dev
```

`GET /health` on `:3400` is the only HTTP surface — it exists because platforms
decide liveness by polling a port, and it is deliberately shallow. It does not
check the broker: a broker outage is what `amqplib`'s reconnect loop is *for*,
and reporting unhealthy through it would have a platform kill a process that is
recovering correctly.

## Wiring it to Jarvis

Jarvis is untouched so far — it still publishes `lease.created` and runs its own
in-process contract worker. [`docs/jarvis-integration.md`](docs/jarvis-integration.md)
has the exact changes to move it onto this service, and what to delete afterwards.
