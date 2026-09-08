import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { setupSwagger, SWAGGER_PATH } from '@/swagger';

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

  const config = app.get(ConfigService);

  /*
   * Off in production by default. The docs describe the shape of everything
   * this service accepts, which is a courtesy internally and a free map
   * anywhere else — set `SWAGGER_ENABLED=true` to serve them there deliberately.
   */
  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled', true);
  if (swaggerEnabled) setupSwagger(app);

  const port = config.get<number>('app.port', 3400);
  await app.listen(port);

  logger.log(
    `listening on :${port} — health at /health` +
      (swaggerEnabled ? `, docs at /${SWAGGER_PATH}` : ''),
  );
}

void bootstrap();
