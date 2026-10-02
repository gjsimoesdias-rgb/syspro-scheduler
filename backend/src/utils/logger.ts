/**
 * Centralised logger.
 *
 * Pino emits structured JSON in production (one event per line, ready for
 * Loki / Splunk / ELK). In development it pipes through pino-pretty for a
 * human-friendly multi-colour format. Either way, every line carries a
 * `traceId` automatically when emitted from inside a request (see
 * httpLogger middleware below).
 */

import pino, { Logger as PinoLogger } from 'pino';
import pinoHttp from 'pino-http';
import { v4 as uuidv4 } from 'uuid';
import environment from '../config/environment';

// LOG_FORMAT=pretty|json overrides; otherwise pretty in dev, JSON in production.
// START_SCHEDULER.cmd runs production with pretty logs (people read that window).
const pretty = process.env.LOG_FORMAT
  ? process.env.LOG_FORMAT.toLowerCase() === 'pretty'
  : environment.nodeEnv !== 'production';

export const logger: PinoLogger = pino({
  level: environment.logLevel || 'info',
  base: { service: 'syspro-scheduler' },
  transport: pretty
    ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          colorize: true,
          singleLine: false,
        },
      }
    : undefined,
  // Redact the obvious — extend as you discover other sensitive paths.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-access-token"]',
      'req.headers["x-auth-token"]',
      'req.body.password',
      'req.body.SYSPRO_DB_PASSWORD',
      'req.body.SCHEDULER_DB_PASSWORD',
      'req.body.token',
      'req.body.secret',
      'req.body.apiKey',
      '*.password',
      '*.token',
      '*.secret',
      '*.apiKey',
      '*.api_key',
      '*.accessToken',
      '*.refreshToken',
      '*.clientSecret',
      '*.client_secret',
    ],
    censor: '[redacted]',
  },
});

/**
 * Express middleware that:
 *  - generates a per-request `traceId` (or honours `x-trace-id` if the
 *    caller already provided one — handy for chaining requests),
 *  - attaches a child logger to `req.log` with `{traceId, method, path}`
 *    pre-bound, so route handlers can `req.log.info({...}, 'message')`,
 *  - logs the request line at `info` on completion.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming =
      (req.headers['x-trace-id'] as string) ||
      (req.headers['x-request-id'] as string);
    const id = incoming && incoming.length <= 64 ? incoming : uuidv4();
    res.setHeader('x-trace-id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) =>
    `${req.method} ${(req as any).originalUrl || req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${(req as any).originalUrl || req.url} ${res.statusCode}: ${
      err?.message ?? 'error'
    }`,
  // Don't dump the entire body and headers on every line — keep logs scannable.
  // Use originalUrl so we get "/api/jobs" instead of the post-router "/" that
  // Express leaves in req.url after routing — that bug surfaced in Week 3.
  serializers: {
    req: (req) => ({
      id: (req as any).id,
      method: req.method,
      url: (req as any).originalUrl || req.url,
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});

export type Logger = PinoLogger;
export default logger;
