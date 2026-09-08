import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import appConfig from '@/config/app.config';
import rabbitmqConfig from '@/config/rabbitmq.config';
import storageConfig from '@/config/storage.config';
import { ContractsModule } from '@/modules/contracts/contracts.module';
import { HealthModule } from '@/modules/health/health.module';
import { PdfModule } from '@/modules/pdf/pdf.module';

/**
 * The root module wires features together and owns no logic of its own.
 *
 * `MessagingModule` and `StorageModule` are deliberately absent here: both are
 * infrastructure, imported by the features that need them rather than made
 * global. That keeps the dependency visible in `ContractsModule` instead of
 * arriving invisibly. Their config namespaces are still loaded centrally below,
 * because `ConfigModule.forRoot` is where every namespace has to be registered
 * regardless of which module later injects it with `forFeature`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, rabbitmqConfig, storageConfig],
      // Read once at boot rather than off `process.env` on every access.
      cache: true,
    }),
    HealthModule,
    ContractsModule,
    PdfModule,
  ],
})
export class AppModule {}
