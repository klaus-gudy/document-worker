import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { DependencyHealth } from '@/common/dependency-health';
import { withTimeout } from '@/common/dependency-health';
import storageConfig from '@/config/storage.config';

/**
 * Object storage, spoken as S3. Locally that is MinIO; nothing below is
 * provider-specific, which is the point — moving to R2 later is an environment
 * variable, not a code change.
 *
 * **Generic on purpose.** It knows nothing about leases or contracts: it
 * exposes `putObject` / `getObject` / `deleteObject` and takes the key it is
 * given. `ContractsService` is its caller today, handing it a key the
 * *publisher* chose — so the one thing this must not do is invent a layout of
 * its own, which would put a second key scheme in a bucket that already has
 * one. Anything that generates a document later (an export, a receipt) calls
 * these the same way.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    this.endpoint = this.config.endpoint;

    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      // MinIO serves buckets as a path (`localhost:9000/jarvis-files/key`), not
      // as a subdomain — virtual-host style would resolve to a hostname that
      // does not exist locally. Harmless against R2, which supports both.
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  /**
   * Confirms the bucket is actually reachable at boot, rather than on the first
   * document someone tries to store.
   *
   * A worker that starts cleanly and only then discovers `STORAGE_BUCKET` is
   * wrong has already accepted responsibility for messages it cannot act on.
   * Failing here means the process never reaches "ready" with a broken bucket.
   */
  async onModuleInit() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    this.logger.log(`connected to bucket "${this.bucket}" at ${this.endpoint}`);
  }

  /**
   * Is the bucket actually reachable right now.
   *
   * Reissues the same `HeadBucketCommand` `onModuleInit` used to fail fast at
   * boot — cheap, read-only, and it needs no object to exist. Bounded by the
   * outer `withTimeout` regardless of how many attempts the SDK's own retry
   * policy makes internally, since a health probe should answer once, quickly,
   * not spend its budget on the SDK's default backoff-and-retry.
   */
  async checkHealth(): Promise<DependencyHealth> {
    const startedAt = Date.now();
    try {
      await withTimeout(
        this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
          requestTimeout: 2000,
        }),
        2000,
      );
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (cause) {
      return {
        status: 'down',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async putObject(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * The object's bytes, or null if the key is not in the bucket. Not-found is
   * modelled as a value rather than a thrown error, because it is an ordinary
   * outcome for a caller to check — a row can outlive its object.
   */
  async getObject(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await result.Body?.transformToByteArray()) ?? null;
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === 'NoSuchKey' || cause.name === 'NotFound')
      ) {
        return null;
      }
      throw cause;
    }
  }

  /**
   * Deleting a key that is not there is a success in S3, which is what makes
   * this safe to call after whatever pointed at it is already gone.
   */
  async deleteObject(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Where an object lives, as a URL — **for logs and the MinIO console, not for
   * a browser.** The bucket is private, so this only resolves for something
   * holding the storage credentials. Whatever ends up persisted alongside a
   * generated document should be the key this method takes, never the URL it
   * returns: a URL bakes today's endpoint into that row, and moving from MinIO
   * to R2 becomes a data migration instead of an environment variable.
   */
  objectUrl(key: string) {
    return `${this.endpoint.replace(/\/+$/, '')}/${this.bucket}/${key}`;
  }

  onApplicationShutdown() {
    this.client.destroy();
    this.logger.log('S3 client closed');
  }
}
