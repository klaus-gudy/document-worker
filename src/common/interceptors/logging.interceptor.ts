import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/** The visual rule that brackets one request/response pair in the log. */
const SEPARATOR =
  '-------------------------------------------------------------------------------------------------------------------';

/**
 * Paths that are polled rather than called.
 *
 * `/health` is hit every 30s by the container's `HEALTHCHECK` and by whatever
 * orchestrator is watching it. Logging those would bury every real request
 * under a wall of noise within minutes, which defeats the point of a log you
 * are meant to read.
 */
const SILENT_PATHS = ['/health'];

/**
 * Body keys whose values never belong in a log.
 *
 * Bodies only — request headers are not logged at all, which is why
 * `authorization` and `cookie` are listed here for the case where one turns up
 * *inside* a payload rather than to cover the header of the same name.
 */
const REDACTED_KEYS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accesskeyid',
  'secretaccesskey',
  'apikey',
];

/**
 * How much of a body to print.
 *
 * The PDF endpoint accepts up to 5,000,000 characters of HTML. Printing that
 * would not be a log line, it would be a denial of service against whoever is
 * reading the terminal.
 */
const MAX_BODY_CHARS = 800;

/**
 * Logs every HTTP request, its response, and anything thrown along the way.
 *
 * **HTTP only.** This service's primary input is a RabbitMQ queue, and an
 * interceptor never sees it — `LeaseCreatedListener` does its own logging.
 * Nothing here covers the message path.
 *
 * `catchError` also sees failures raised by pipes (a `ValidationPipe` 400
 * arrives here), because pipes run inside the interceptor's observable. It does
 * **not** see failures from guards or middleware, which run before interceptors
 * are reached; there are none in this app today, and an exception filter is the
 * thing that would cover them if that changes.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A non-HTTP execution context has no request to describe. Cheap to check,
    // and it keeps this from throwing if the app ever gains a microservice
    // transport.
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { method, originalUrl } = request;

    if (SILENT_PATHS.some((path) => originalUrl.startsWith(path))) {
      return next.handle();
    }

    const startedAt = Date.now();

    this.logger.log(`\n${SEPARATOR}`);
    this.logger.log(`[INCOMING REQUEST] ${method} ${originalUrl}`);
    this.logger.log(
      `  from: ${request.ip ?? 'unknown'}  agent: ${request.get('user-agent') ?? '—'}`,
    );

    const body = this.describeBody(request.body);
    if (body) this.logger.log(`  body: ${body}`);

    return next.handle().pipe(
      tap((data) => {
        const elapsed = Date.now() - startedAt;
        this.logger.log(
          `[RESPONSE] ${method} ${originalUrl} ${response.statusCode} +${elapsed}ms`,
        );
        this.logger.log(`  returned: ${this.describeResponse(data)}`);
        this.logger.log(`${SEPARATOR}\n`);
      }),
      catchError((error: unknown) => {
        const elapsed = Date.now() - startedAt;
        const status =
          error instanceof HttpException
            ? error.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        this.logger.error(
          `[ERROR] ${method} ${originalUrl} ${status} +${elapsed}ms`,
        );
        this.logger.error(
          `  ${error instanceof Error ? error.message : String(error)}`,
        );

        // An HttpException carries a structured body — a ValidationPipe's list
        // of what was wrong with the request, which is the useful part.
        if (error instanceof HttpException) {
          this.logger.error(`  detail: ${JSON.stringify(error.getResponse())}`);
        } else if (error instanceof Error && error.stack) {
          // Only for genuinely unexpected failures. A 400 does not need a
          // stack trace; a TypeError does.
          this.logger.error(error.stack);
        }

        this.logger.error(`${SEPARATOR}\n`);

        // Rethrown, not swallowed: this observes, it does not handle. Nest's
        // exception layer still owns what the caller actually receives.
        return throwError(() => error);
      }),
    );
  }

  /** A request body, redacted and truncated, or null when there is nothing to show. */
  private describeBody(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    if (Object.keys(body).length === 0) return null;

    const serialised = JSON.stringify(this.redact(body));
    return serialised.length > MAX_BODY_CHARS
      ? `${serialised.slice(0, MAX_BODY_CHARS)}… (${serialised.length} chars total)`
      : serialised;
  }

  /**
   * What the handler returned, summarised.
   *
   * Binary is described, never printed: `/api/v1/pdf/render` returns a
   * `StreamableFile` wrapping ~100KB of PDF, and dumping that into a terminal
   * would be megabytes of mojibake per request.
   */
  private describeResponse(data: unknown): string {
    if (data instanceof StreamableFile) return 'StreamableFile (binary stream)';
    if (Buffer.isBuffer(data)) return `Buffer (${data.byteLength} bytes)`;
    if (data === undefined || data === null) return 'no body';

    const serialised = JSON.stringify(this.redact(data));
    return serialised.length > MAX_BODY_CHARS
      ? `${serialised.slice(0, MAX_BODY_CHARS)}… (${serialised.length} chars total)`
      : serialised;
  }

  /** Replaces the value of any sensitive-looking key, at any depth. */
  private redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value === null || typeof value !== 'object') return value;

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        REDACTED_KEYS.includes(key.toLowerCase())
          ? '[REDACTED]'
          : this.redact(entry),
      ]),
    );
  }
}
