import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { configureApp } from '@/configure-app';
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
  const { apiPrefix } = configureApp(app);

  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled', true);
  if (swaggerEnabled) setupSwagger(app);

  const port = config.get<number>('app.port', 3400);
  await app.listen(port);

  const base = `http://localhost:${port}`;
  logger.log(`Application is running on: ${base}/${apiPrefix}`);
  logger.log(`Health check:              ${base}/health`);
  if (swaggerEnabled) {
    logger.log(`API docs:                  ${base}/${SWAGGER_PATH}`);
  }
}

void bootstrap();
