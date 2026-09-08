import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HealthResponseDto } from '@/modules/health/dto/health-response.dto';

/**
 * The one HTTP surface this app exposes.
 *
 * This is a queue listener — its real input is the broker — but a platform that
 * decides liveness by polling a port needs something to poll, and a process
 * with no such route gets restarted on a schedule nobody chose.
 *
 * Deliberately shallow: it does not check the broker. A brief broker outage is
 * something to reconnect through, not to report as an unhealthy process a
 * platform should kill.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Reports that the process is up and its event loop is turning. Does not ' +
      'check RabbitMQ — a brief outage is reconnected through, not a reason to ' +
      'have the process killed.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
