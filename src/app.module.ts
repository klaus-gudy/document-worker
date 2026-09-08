import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Validated once, at boot, so a missing `STORAGE_BUCKET` stops the
      // process before it has taken responsibility for any request.
      validate: validateEnv,
      cache: true,
    }),
    DocumentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
