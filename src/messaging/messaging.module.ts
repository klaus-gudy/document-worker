import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import rabbitmqConfig from '@/config/rabbitmq.config';
import { RabbitmqService } from '@/messaging/rabbitmq.service';

/**
 * Infrastructure, not a feature. It owns the broker connection and nothing
 * else, so feature modules import it rather than each opening their own.
 */
@Module({
  imports: [ConfigModule.forFeature(rabbitmqConfig)],
  providers: [RabbitmqService],
  exports: [RabbitmqService],
})
export class MessagingModule {}
