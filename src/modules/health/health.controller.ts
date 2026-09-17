import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RabbitmqService } from '@/messaging/rabbitmq.service';
import { HealthResponseDto } from '@/modules/health/dto/health-response.dto';
import { StorageService } from '@/storage/storage.service';

/**
 * The one HTTP surface this app exposes.
 *
 * This is a queue listener — its real input is the broker — but a platform that
 * decides liveness by polling a port needs something to poll, and a process
 * with no such route gets restarted on a schedule nobody chose.
 *
 * **This checks RabbitMQ and MinIO**, so it reports a dependency outage rather
 * than answering `ok` from a process that cannot do its job.
 *
 * **Read this as a combined liveness+readiness probe, and know what that
 * costs.** A platform pointed at this will restart the process on any broker
 * or MinIO blip, including ones that recover on their own in seconds — a
 * restart storm during, say, a RabbitMQ rolling upgrade, for a process that
 * did nothing wrong. That restart is now pure cost on the broker side:
 * `RabbitmqService` reconnects with backoff and replays its subscriptions, so
 * the same outage heals without anything being restarted. Splitting this into
 * a liveness route (always `ok` if the event loop answers) and a readiness
 * route (this one) is the remaining half of that fix; ask if you want it.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness + dependency check',
    description:
      'Reports process uptime plus a live probe of RabbitMQ and the MinIO ' +
      'bucket. Returns 503 if either is down — see the class-level note on ' +
      'what that means for restart behavior.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'RabbitMQ or MinIO is unreachable.',
    type: HealthResponseDto,
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    // Run together, not one after another: two independent dependencies have
    // no reason to make each other's timeout additive, and this halves the
    // worst case from ~4s to ~2s.
    const [rabbitmqHealth, storageHealth] = await Promise.all([
      this.rabbitmq.checkHealth(),
      this.storage.checkHealth(),
    ]);

    const degraded =
      rabbitmqHealth.status === 'down' || storageHealth.status === 'down';

    res.status(degraded ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);

    return {
      status: degraded ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      checks: { rabbitmq: rabbitmqHealth, storage: storageHealth },
    };
  }
}
