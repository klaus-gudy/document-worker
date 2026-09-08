import { Module } from '@nestjs/common';

import { LeaseCreatedListener } from './lease-created.listener';
import { RabbitmqService } from './rabbitmq.service';

@Module({
  providers: [RabbitmqService, LeaseCreatedListener],
  exports: [RabbitmqService],
})
export class RabbitmqModule {}
