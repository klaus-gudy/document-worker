import { Controller, Get } from '@nestjs/common';

/**
 * The one HTTP surface this worker exposes.
 *
 * It is not an API — the worker's whole input is the queue. This exists because
 * every platform worth deploying to decides liveness by polling a port, and a
 * process with none gets restarted on a schedule nobody chose.
 *
 * Deliberately shallow. It used to query Postgres; there is no Postgres now,
 * and the remaining dependencies are the wrong things to check here. A broker
 * outage is what `amqplib`'s reconnect loop is *for* — reporting unhealthy
 * through it would have a platform kill a process that is recovering correctly.
 * Storage is only reachable by writing to it, which a liveness probe has no
 * business doing every fifteen seconds. What this answers is the question a
 * probe is actually asking: is the process up and its event loop turning.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
