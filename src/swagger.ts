import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { LeaseCreatedEvent } from '@/modules/contracts/events/lease-created.event';

/** Where the UI is served. `${SWAGGER_PATH}-json` serves the raw OpenAPI document. */
export const SWAGGER_PATH = 'docs';

/**
 * Mounts the OpenAPI docs.
 *
 * Its own file rather than twenty lines in `main.ts`, so bootstrap stays a list
 * of things that happen and this stays the one place that decides what the docs
 * say.
 *
 * **Worth being honest about what this can and cannot document.** OpenAPI
 * describes HTTP, and this service's real interface is a RabbitMQ queue — the
 * only route it serves is a liveness probe. `lease.created` is therefore
 * registered below as a schema with `extraModels`: it belongs to no endpoint, so
 * nothing would otherwise pull it into the document, and the payload shape is
 * the thing a reader actually needs. AsyncAPI is the specification that covers
 * message-driven interfaces properly, if this grows enough to want it.
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Document Worker')
    .setDescription(
      'A queue listener. It consumes `lease.created` from the ' +
        '`jarvis.events` topic exchange and processes it.\n\n' +
        'The HTTP surface below is only a liveness probe — the service takes ' +
        'its real input from RabbitMQ. See the **LeaseCreatedEvent** schema for ' +
        'the message contract it consumes.',
    )
    .setVersion('0.0.1')
    .addTag('health', 'Liveness probing')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // Not reachable from any route, so it has to be named explicitly or it
    // would be absent from the document entirely.
    extraModels: [LeaseCreatedEvent],
  });

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: {
      // Keeps the tried-out endpoint and expansion state across a reload.
      persistAuthorization: true,
    },
  });
}
