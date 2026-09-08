import { registerAs } from '@nestjs/config';

/**
 * Object storage, spoken as S3. Locally this is the MinIO container from
 * Jarvis's `docker-compose.yml`; in production it can be Cloudflare R2 or any
 * other S3-compatible endpoint — only these values change.
 *
 * Named `storage`, not `minio`: nothing in the code that uses this should know
 * or care which provider is behind it.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
  bucket: process.env.STORAGE_BUCKET ?? 'jarvis-files',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin123',

  /**
   * R2 ignores the region and MinIO has none, but the AWS SDK refuses to build
   * a request without one. "auto" is what Cloudflare's own docs use, and MinIO
   * accepts it without complaint.
   */
  region: process.env.STORAGE_REGION ?? 'auto',
}));
