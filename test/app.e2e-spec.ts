import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { configureApp } from '@/configure-app';

/**
 * Exercises the app the way a real caller does: over HTTP, through the same
 * `configureApp` that `main.ts` runs — so this test and production cannot
 * silently apply different rules. `Test.createTestingModule` never calls
 * `bootstrap()`, so without sharing that function this suite would test an
 * app with no global prefix and no `ValidationPipe`, which is not the app
 * anyone actually runs.
 *
 * **Needs RabbitMQ and MinIO reachable at whatever `.env` points to.** That is
 * not a compromise particular to this test — the app has no code path that
 * works without them: `RabbitmqService` and `StorageService` connect from
 * `onModuleInit`, before a single request can be handled, so `app.init()`
 * below already requires both to be up. There is nothing left to fake.
 *
 *   docker start shared-rabbitmq jarvis-minio
 *   npm run test:e2e
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let apiPrefix: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    ({ apiPrefix } = configureApp(app));
    await app.init();

    server = app.getHttpServer();
  });

  afterAll(async () => {
    // Closes cleanly with no `enableShutdownHooks()` call: `app.close()` runs
    // `onApplicationShutdown` on every provider regardless, which is what
    // actually closes Chromium and the AMQP connections rather than leaking
    // them across test files.
    await app.close();
  });

  describe('GET /health', () => {
    it('is reachable at the bare path, outside the API prefix', async () => {
      // The prefix excludes `health` on purpose — see `configureApp`'s own
      // comment. Asserting the bare path here is what would catch that
      // exclusion silently breaking.
      await request(server).get(`/${apiPrefix}/health`).expect(404);
    });

    it('reports both dependencies up', async () => {
      const response = await request(server).get('/health').expect(200);

      const body = response.body as {
        status: string;
        uptimeSeconds: number;
        checks: { rabbitmq: { status: string }; storage: { status: string } };
      };

      expect(body).toMatchObject({
        status: 'ok',
        checks: {
          rabbitmq: { status: 'up' },
          storage: { status: 'up' },
        },
      });
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('POST /pdf/render', () => {
    const endpoint = () => `/${apiPrefix}/pdf/render`;

    it('renders a real PDF from HTML', async () => {
      const response = await request(server)
        .post(endpoint())
        .send({ html: '<h1>e2e</h1>', fileName: 'e2e-test.pdf' })
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('e2e-test.pdf');
      // A real PDF, not just a 200 with an empty body — `%PDF-` is the file
      // signature every PDF starts with, whatever renderer produced it.
      const pdf = response.body as Buffer;
      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('rejects a body with no html', async () => {
      const response = await request(server)
        .post(endpoint())
        .send({ fileName: 'no-html.pdf' })
        .expect(400);

      const body = response.body as { message: string[] };
      expect(body.message).toEqual(
        expect.arrayContaining([expect.stringContaining('html')]),
      );
    });

    it('rejects an unknown field — proves the global ValidationPipe is wired', async () => {
      // This is the assertion the previous e2e file could not make at all: a
      // `ValidationPipe` configured only in `main.ts` never ran against a test
      // built through `Test.createTestingModule`, so a global validation
      // regression had no test to catch it before this file shared
      // `configureApp`.
      await request(server)
        .post(endpoint())
        .send({ html: '<p>x</p>', evil: true })
        .expect(400);
    });
  });
});
