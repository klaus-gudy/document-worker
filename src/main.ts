import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /*
   * Without this, SIGTERM kills the process where it stands — with a message
   * unacked and the AMQP socket dropped, so the broker waits out a timeout
   * before redelivering. With it, Nest calls `onApplicationShutdown` and the
   * channel and connection close properly.
   */
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
