import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '@/config/app.config';
import rabbitmqConfig from '@/config/rabbitmq.config';
import { ContractsModule } from '@/modules/contracts/contracts.module';
import { HealthModule } from '@/modules/health/health.module';

/**
 * The root module wires features together and owns no logic of its own.
 *
 * `MessagingModule` is deliberately absent here: it is infrastructure, imported
 * by the features that need a broker rather than made global. That keeps the
 * dependency visible in `ContractsModule` instead of arriving invisibly.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, rabbitmqConfig],
      // Read once at boot rather than off `process.env` on every access.
      cache: true,
    }),
    HealthModule,
    ContractsModule,
  ],
})
export class AppModule {}
