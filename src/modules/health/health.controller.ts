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
 * The one HTTP surface this app exposes — now two routes, not one, because
 * "is the process alive" and "can it currently do its job" are different
 * questions with different consequences for getting them wrong.
 *
 * **`/health/live` — liveness. Always `ok` if the event loop answers.** This
 * is the route to restart on. `RabbitmqService` reconnects with backoff and
 * replays its subscriptions on its own, so a broker blip is not a reason to
 * kill this process — doing so would restart something that was already
 * fixing itself, which is pure cost with no benefit. Nothing here checks a
 * dependency, on purpose: a route that can fail because MinIO is slow is a
 * liveness route in name only.
 *
 * **`/health/ready` — readiness. Probes RabbitMQ and MinIO, 503 if either is
 * down.** This is the route to gate traffic on, or simply to watch — it tells
 * you the process is up but *cannot* currently do its job, which is a
 * genuinely different fact from "restart me".
 *
 * **`GET /health`** stays as an alias for `/health/ready`, unchanged in shape
 * and status codes. Removing it would break anything already pointed at it —
 * this repo's own `Dockerfile` was, until this same change moved it to
 * `/health/live` for the reason above.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly rabbitmq: RabbitmqService,
    private readonly storage: StorageService,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Always `ok` if this process is running and its event loop answers. ' +
      'Checks no dependency — a broker or bucket outage is not a reason to ' +
      'restart a process that is actively reconnecting on its own. Point a ' +
      "platform's restart policy at this route, not at /health/ready.",
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  live(): HealthResponseDto {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      checks: undefined,
    };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports process uptime plus a live probe of RabbitMQ and the MinIO ' +
      'bucket. Returns 503 if either is down. This is a "can it work right ' +
      'now" signal, not a "kill it" signal — see the class-level note.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'RabbitMQ or MinIO is unreachable.',
    type: HealthResponseDto,
  })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    return this.checkReadiness(res);
  }

  /** Kept at the bare path as a stable alias for `/health/ready`. */
  @Get()
  @ApiOperation({
    summary: 'Readiness probe (alias of /health/ready)',
    description:
      'Identical to /health/ready, kept at the original path so nothing ' +
      'already pointed here breaks. Prefer /health/live or /health/ready ' +
      'explicitly in new configuration.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'RabbitMQ or MinIO is unreachable.',
    type: HealthResponseDto,
  })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    return this.checkReadiness(res);
  }

  private async checkReadiness(res: Response): Promise<HealthResponseDto> {
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
