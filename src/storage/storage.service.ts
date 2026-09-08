import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Object storage, spoken as S3. Locally that is the MinIO in Jarvis's
 * `docker-compose.yml`; in production it is Cloudflare R2. Nothing below is
 * provider-specific — the `STORAGE_*` variables are the entire difference,
 * which is the point: the upload path is exercised for real in development
 * rather than being tried for the first time after a deploy.
 *
 * The bucket is private and stays private. This worker writes objects and
 * records their keys; it hands no URL to a browser. Reads go back through the
 * app's `GET /api/documents/[id]`, which has already checked that the caller's
 * organization owns the row.
 */
@Injectable()
export class StorageService implements OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
    this.endpoint = config.getOrThrow<string>('STORAGE_ENDPOINT');

    this.client = new S3Client({
      endpoint: this.endpoint,
      region: config.getOrThrow<string>('STORAGE_REGION'),
      // MinIO serves buckets as a path (`localhost:9000/jarvis-files/key`), not
      // as a subdomain — virtual-host style would resolve to a hostname that
      // does not exist locally.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
      },
    });
  }

  async putObject(objectKey: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * The object's bytes. Null when the key is not in the bucket — which should
   * not happen, but does whenever a row outlives its object, and "not there"
   * reads better than a thrown `NoSuchKey` for a file someone deleted out from
   * under the app.
   */
  async getObject(objectKey: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
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
   * Deleting a key that isn't there is a success in S3, which is what makes
   * this safe to call after the row has already gone.
   */
  async deleteObject(objectKey: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
  }

  /**
   * Where the object lives, as a URL.
   *
   * **For logs and for the MinIO console, not for a tenant.** The bucket is
   * private, so this URL only resolves for something holding the storage
   * credentials — it is the address of the object, not a way to fetch it. What
   * gets persisted is `FileAsset.objectKey`, the path within the bucket, so
   * that moving from MinIO to R2 changes an environment variable rather than
   * every row.
   */
  objectUrl(objectKey: string) {
    return `${this.endpoint.replace(/\/+$/, '')}/${this.bucket}/${objectKey}`;
  }

  onApplicationShutdown() {
    this.client.destroy();
    this.logger.log('S3 client closed');
  }
}
