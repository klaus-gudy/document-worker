import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',

  /**
   * This app is a queue listener; the HTTP port exists so `app.listen()` has
   * one and so a platform that decides liveness by polling a port has something
   * to poll. See `HealthController`.
   */
  port: Number(process.env.PORT ?? 3400),
}));
