# document-worker

Renders HTML to PDF and puts it in object storage. That is the whole job.

It holds no domain model — no leases, no tenants, no database. A publisher
decides what a document says and where it belongs; this renders what it is
handed and stores it at the key it is given. That separation is the point: it
is what keeps a ~100MB headless browser out of the app that owns the data.

## The message contract

Consumes **`lease.created`** from the topic exchange `jarvis.events`, on its own
queue `DOCUMENT_WORKER_QUEUE`. Plain JSON, no framework envelope.

```json
{
  "html": "<!DOCTYPE html><html><head><style>…</style></head><body>…</body></html>",
  "objectKey": "organizations/<orgId>/leases/<leaseId>/<uuid>.pdf",
  "footerText": "Standard tenancy agreement · L-LWX8G",
  "meta": { "leaseId": "lease-456", "fileName": "contract-L-LWX8G.pdf" }
}
```

| Field | Required | Notes |
|---|---|---|
| `html` | **yes** | A **complete** document with the stylesheet **inlined**. Rendered exactly as given — nothing is added. Remote content is blocked at the network layer, so a `<link>` to a stylesheet silently will not load and you will file an unstyled document. |
| `objectKey` | **yes** | Honoured verbatim. This service invents no keys, so the publisher's scheme is the only one in the bucket. |
| `footerText` | no | Printed at the foot of every page beside a page counter. Trimmed, capped at 200 chars; absent or blank means no footer at all. |
| `meta` | no | **Opaque.** Anything the publisher wants handed back on `document.stored`. Never read, parsed or acted on here — that is what lets it carry a lease id without this service learning what a lease is. Keep it small: it rides on every message and returns on every completion. |

A message missing `html` or `objectKey` is rejected to
`DOCUMENT_WORKER_QUEUE_DEAD` — it will still be missing them on a redelivery.
Inspect the holding area with `npm run dead-letters`.

**Layout is this service's, content is the publisher's.** `CONTRACT_PDF_OPTIONS`
fixes the format and margins (A4, 18/16/20/16mm) and a message cannot override
them — a test asserts a message carrying `format` or `margin` is ignored, because
a stored contract is a record and one laid out however the publisher felt that
day is one nobody can reproduce. `footerText` is the deliberate exception, and
it is an exception about *words*: a template name and a reference this service
could not invent without the domain model it does not have. `meta` is not an
exception at all, because it never reaches the renderer.

`PdfService`'s own `DEFAULT_MARGIN` is kept in step with `CONTRACT_PDF_OPTIONS`
on purpose, so a document rendered through the HTTP route to see how it looks
comes out the same shape as one the queue files.

### What it announces

After the upload succeeds, publishes **`document.stored`** to the same exchange:

```json
{
  "objectKey": "organizations/<orgId>/leases/<leaseId>/<uuid>.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 104207,
  "storedAt": "2026-09-11T09:14:02.000Z",
  "meta": { "leaseId": "lease-456", "fileName": "contract-L-LWX8G.pdf" }
}
```

**This service still holds no domain model.** The four fields above are
everything it knows on its own — where the bytes went, what they are, how many,
and when. `meta` is whatever the request carried, returned untouched; it is
omitted entirely (not sent as `{}`) when the request carried none, so a
publisher can tell "nothing was sent" from "an empty object was".

`objectKey` is a correlation id in its own right and is always present, so a
publisher that sends no `meta` can still match a completion to its request.
Nothing has to bind to this routing key; an unbound key on a topic exchange is a
silent no-op, not an error.

Message ordering matters and is deliberate: the object is written **before** the
announcement, so a failure between the two leaves an orphaned object rather than
a record pointing at bytes that are not there.

## HTTP

Also renders over HTTP, which is how you check what a document looks like
without publishing anything:

```bash
curl -X POST http://localhost:3400/api/v1/pdf/render \
  -H 'Content-Type: application/json' \
  -d '{"html":"<!doctype html><html><body><h1>Hi</h1></body></html>","footerText":"Demo · 1"}' \
  --output out.pdf
```

`GET /health` reports the broker and the bucket. API docs at `/docs`.

## Running it

```bash
npm install          # postinstall fetches Chromium
npm run start:dev
```

`.env` — see `.env.example`. The defaults point at the infrastructure in the
publisher's `docker-compose.yml`:

| Variable | Default | Notes |
|---|---|---|
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5682` | **Port 5682**, not 5672 — that compose file shifts it so it cannot collide with a broker already running locally. |
| `EVENT_EXCHANGE` | `jarvis.events` | Topic. |
| `EVENT_QUEUE` | `DOCUMENT_WORKER_QUEUE` | This service's mailbox. Dead letters go to `<queue>_DEAD`. |
| `EVENT_ROUTING_KEY` | `lease.created` | **A contract with the publisher, not a preference.** Get it wrong and the exchange routes to no queue and drops the message silently. Change both sides together. |
| `EVENT_COMPLETION_ROUTING_KEY` | `document.stored` | What it announces on. |
| `STORAGE_*` | MinIO on `:9000`, bucket `jarvis-files` | Same S3 API as R2, so production is a config change. |

```bash
npm run publish:lease            # publish a sample message
npm run publish:lease -- --count 3
npm run dead-letters             # inspect the holding area
npm test
```

### A note on the dead-letter exchange

`jarvis.events.dlx` is asserted **`direct`**, and the publisher must agree — an
exchange's type is fixed at creation, so if one side declares `fanout` the other
gets `PRECONDITION_FAILED` and loses its channel. `direct` is the right type
here: rejects are routed by the originating queue's own name, so each consumer's
failures land in its own holding area instead of a fanout copying every reject
into all of them.

A queue's arguments are likewise fixed at creation. If this service refuses to
start with `PRECONDITION_FAILED`, the queue predates its dead-letter settings —
drain it, delete it, and let it be recreated:

```bash
docker exec <broker> rabbitmqctl delete_queue DOCUMENT_WORKER_QUEUE
```

## Known gaps

- **No reconnect.** A dropped broker connection stays dropped until the process
  restarts; `GET /health` is what makes that visible rather than silent.
- **A bad payload and a storage outage take the same path.** Both are rejected
  to the dead-letter queue, where the second really wants a retry.
- **No cap on `html` from the queue.** The HTTP route caps it at 5MB via
  `RenderPdfDto`; a queue message never passes through `ValidationPipe`.
