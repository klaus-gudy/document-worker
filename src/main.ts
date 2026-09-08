import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/**
 * The document worker.
 *
 * It listens for `document.requested`, renders the HTML it carries to PDF
 * through Chromium, puts the bytes in the object store, and publishes
 * `document.generated` with the key they landed under. It has no database and
 * knows nothing about what it is printing — the requester decided that, and
 * owns whatever record the result belongs on.
 *
 * It is a Nest *HTTP* app rather than a bare application context for one
 * reason: the health endpoint. Nothing else here is served over HTTP, and the
 * queue consumer starts on `onApplicationBootstrap` regardless of whether
 * anything ever hits the port.
 */
async function bootstrap() {
  const logger = new Logger('bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  /*
   * Without this, SIGTERM kills the process where it stands: mid-render, with a
   * message unacked and a Chromium still running. With it, Nest runs
   * `onApplicationShutdown` on every provider — the AMQP channels close so the
   * broker redelivers rather than waiting out a timeout, Chromium exits, and
   * the S3 client's sockets go with it.
   */
  app.enableShutdownHooks();

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);

  logger.log(`document worker listening on :${port} (health at /health)`);
}

void bootstrap();
