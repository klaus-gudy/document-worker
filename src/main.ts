import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  /*
   * Without this, SIGTERM kills the process where it stands — with a message
   * unacked and the AMQP socket dropped, so the broker waits out a timeout
   * before redelivering. With it, Nest calls `onApplicationShutdown` and the
   * channel and connection close properly.
   */
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('app.port', 3400);
  await app.listen(port);

  logger.log(`listening on :${port} — health at /health`);
}

void bootstrap();
