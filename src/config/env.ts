import { z } from 'zod';

/**
 * Every environment variable this worker reads, validated once at boot.
 *
 * Validated rather than read where it is needed, because the failure it
 * prevents is the expensive one: a worker that starts, consumes a message,
 * renders a document, and only then discovers `STORAGE_BUCKET` is blank —
 * having already nacked the request into the dead-letter queue for a reason
 * that had nothing to do with the request. A missing variable should stop the
 * process before it has taken responsibility for anything.
 *
 * Defaults match Jarvis's `docker-compose.yml`, so a fresh checkout with only
 * the four `STORAGE_*` values set talks to the same broker and bucket the app
 * does.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  /**
   * The health endpoint's port. The worker is not an HTTP service — this exists
   * so a platform that decides liveness by polling a port has something to poll,
   * which is most of them.
   */
  PORT: z.coerce.number().int().positive().default(3400),

  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5682'),
  EVENTS_EXCHANGE: z.string().default('jarvis.events'),
  DOCUMENT_QUEUE: z.string().default('documents.generate'),

  /**
   * How many documents to render at once.
   *
   * One, deliberately. Each render holds a Chromium page open, and the honest
   * ceiling here is memory rather than CPU — raising it is a decision to be
   * made against a measured box, not a default.
   */
  DOCUMENT_PREFETCH: z.coerce.number().int().positive().default(1),

  /**
   * One retry, then the dead-letter queue.
   *
   * A rendering or storage failure is usually transient (a browser that died, a
   * bucket that blinked) and worth one more go. Anything that fails twice is
   * almost certainly not transient, and requeueing it forever would spin this
   * process on one poisoned message while every later request waits behind it.
   */
  DOCUMENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),

  STORAGE_ENDPOINT: z.string().min(1, 'STORAGE_ENDPOINT is required'),
  STORAGE_BUCKET: z.string().min(1, 'STORAGE_BUCKET is required'),
  STORAGE_ACCESS_KEY_ID: z.string().min(1, 'STORAGE_ACCESS_KEY_ID is required'),
  STORAGE_SECRET_ACCESS_KEY: z
    .string()
    .min(1, 'STORAGE_SECRET_ACCESS_KEY is required'),
  /**
   * R2 ignores the region and MinIO has none, but the SDK refuses to build a
   * request without one. "auto" is what Cloudflare's own documentation uses.
   */
  STORAGE_REGION: z.string().default('auto'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `ConfigModule`'s `validate` hook. Reports every bad variable at once rather
 * than the first: on a fresh deploy the cause is usually two or three of them,
 * and finding out one restart at a time is the slowest possible way to learn it.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }

  return result.data;
}
