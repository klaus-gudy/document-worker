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
 * **This now checks RabbitMQ and MinIO, which reverses an earlier decision**
 * (see git history) to keep this shallow and never fail it on a broker outage.
 * That reasoning assumed the connection would reconnect on its own; it does
 * not — `RabbitmqService` has no retry loop, so a dropped connection stays
 * dropped until this process is restarted. Reporting it here is currently the
 * *only* way anything finds out that needs to happen.
 *
 * **Read this as a combined liveness+readiness probe, and know what that
 * costs.** A platform pointed at this will restart the process on any broker
 * or MinIO blip, including ones that recover on their own in seconds — a
 * restart storm during, say, a RabbitMQ rolling upgrade, for a process that
 * did nothing wrong. The fix that actually removes this tradeoff is giving
 * `RabbitmqService` its own reconnect logic and splitting this into a
 * liveness route (always `ok` if the event loop answers) and a separate
 * readiness route (this one); ask if you want that instead of the restart
 * behavior below.
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
