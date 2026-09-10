import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Everything that turns a bare Nest application into *this* application:
 * the API prefix, the exclusion for `/health`, and the validation pipe.
 *
 * Pulled out of `main.ts` for one reason — an e2e test builds its `app`
 * through `Test.createTestingModule(...).compile()`, never through
 * `bootstrap()`, so without this the test would exercise a differently
 * configured app than what actually runs in production: no prefix, no
 * validation, `POST /api/v1/pdf/render` reachable at a different path than the
 * real deployment. Both call sites now share one function, so they cannot
 * silently drift apart.
 */
export function configureApp(app: INestApplication): { apiPrefix: string } {
  const config = app.get(ConfigService);
  const apiPrefix = config.get<string>('app.apiPrefix', 'api/v1');

  /*
   * `health` excluded on purpose: a platform's liveness probe should not need
   * to know or agree on an API version to find the process, so it stays
   * reachable at bare `/health` regardless of what `apiPrefix` is set to.
   */
  app.setGlobalPrefix(apiPrefix, { exclude: ['health'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  return { apiPrefix };
}
