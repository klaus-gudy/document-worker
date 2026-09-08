import { Controller, Get } from '@nestjs/common';

/**
 * The one HTTP surface this app exposes.
 *
 * It replaces the scaffold's "Hello World!" route. This is a queue listener —
 * its real input is the broker — but a platform that decides liveness by
 * polling a port needs something to poll, and a process with no such route gets
 * restarted on a schedule nobody chose.
 *
 * Deliberately shallow: it does not check the broker. A brief broker outage is
 * something to reconnect through, not to report as an unhealthy process a
 * platform should kill.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
