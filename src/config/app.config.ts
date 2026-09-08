import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',

  /**
   * This app is a queue listener; the HTTP port exists so `app.listen()` has
   * one and so a platform that decides liveness by polling a port has something
   * to poll. See `HealthController`.
   */
  port: Number(process.env.PORT ?? 3400),

  /**
   * Prefixed onto every HTTP route except `health` — see `main.ts`. A
   * platform's liveness probe should not need to know or agree on an API
   * version to find it, so it stays reachable at bare `/health` regardless.
   */
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',

  /**
   * Whether to serve the OpenAPI docs.
   *
   * Off in production unless asked for: the document describes the shape of
   * everything the service accepts, which is a convenience on an internal
   * network and a free map on a public one.
   */
  swaggerEnabled:
    process.env.SWAGGER_ENABLED === 'true' ||
    (process.env.SWAGGER_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'production'),
}));
