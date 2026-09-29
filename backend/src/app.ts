/**
 * Express application setup
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import scheduleRoutes from './api/routes/schedule';
import jobRoutes from './api/routes/jobs';
import resourceRoutes from './api/routes/resources';
import statusRoutes from './api/routes/status';
import inventoryRoutes from './api/routes/inventory';
import authRoutes from './api/routes/auth';
import ntlmAuthRoutes from './api/routes/ntlmAuth';
import userRoutes from './api/routes/users';
import licenseRoutes from './api/routes/licenses';
import appSettingsRoutes from './api/routes/appSettings';
import auditRoutes from './api/routes/audit';
import eventsRoutes from './api/routes/events';
import scenariosRoutes from './api/routes/scenarios';
import shopfloorRoutes from './api/routes/shopfloor';
import rateLimit from 'express-rate-limit';
import environment from './config/environment';
import { httpLogger, logger } from './utils/logger';
import { requireAuth } from './api/middleware/requireAuth';

const app: Express = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Structured request logging — emits one JSON event per request in
// production with a traceId, latency and status code. In dev pino-pretty
// turns it into a colourised single-line log. The traceId also flows out
// in the `x-trace-id` response header so the UI/curl can correlate.
app.use(httpLogger);

// Liveness — the process is up. Always 200 unless the event loop is dead.
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Readiness — the process is up AND its hard dependencies (Syspro DB) are
// usable. Returns 503 with a clear reason when the DB is missing so a
// load-balancer / Kubernetes / orchestrator can route traffic correctly.
app.get('/health/ready', (req: Request, res: Response) => {
  const sysproDb = req.app.locals.sysproDb;
  const schedulerDb = req.app.locals.schedulerDb;
  const ready = !!sysproDb;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'READY' : 'NOT_READY',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {
      sysproDb: sysproDb ? 'connected' : 'disconnected',
      schedulerDb: schedulerDb ? 'connected' : 'disconnected',
    },
  });
});

// Rate limiting — prevent runaway schedule generation and brute-force auth
const isProd = process.env.NODE_ENV === 'production';

const scheduleRateLimit = rateLimit({
  windowMs: 60_000,
  max: isProd ? 10 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many schedule requests, please wait a minute.' },
});

const authRateLimit = rateLimit({
  windowMs: 15 * 60_000, // 15 minutes
  max: isProd ? 20 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

// API routes
// Public: auth (login / refresh / logout / NTLM handshake), health, shopfloor
app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api/auth/ntlm', authRateLimit, ntlmAuthRoutes);
app.use('/api/shopfloor', shopfloorRoutes);

// Protected: all remaining routes require a valid JWT
app.use('/api/schedule', eventsRoutes);   // SSE events stream — public, EventSource can't send headers; MUST be before requireAuth
app.use('/api/schedule', scheduleRateLimit, requireAuth, scheduleRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/resources', requireAuth, resourceRoutes);
// /databases and /connect are always allowed without JWT — these are the
// pre-login setup routes used to configure the database connection.
// All other status routes remain protected once the DB is live.
app.use('/api/status', (req: Request, res: Response, next: NextFunction) => {
  const isSetupRoute = req.path === '/databases' || req.path === '/connect';
  if (isSetupRoute) return next();
  return requireAuth(req, res, next);
}, statusRoutes);
app.use('/api/inventory', requireAuth, inventoryRoutes);
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/licenses', requireAuth, licenseRoutes);
app.use('/api/settings', requireAuth, appSettingsRoutes);
app.use('/api/audit', requireAuth, auditRoutes);
app.use('/api/scenarios', requireAuth, scenariosRoutes);

// Serve the React frontend whenever a `frontend/build/` directory is
// present. We deliberately don't require NODE_ENV=production any more —
// after one `npm run build:frontend` the user can hit http://localhost:3000/
// and get the full UI plus the API on the same origin. Multiple candidate
// paths are checked so this works whether the backend is run via ts-node
// from src/, or as compiled JS from dist/, or from the installer package.
const candidateBuildPaths = [
  path.resolve(process.cwd(), '..', 'frontend', 'build'),
  path.resolve(process.cwd(), '..', '..', 'frontend', 'build'),
  path.resolve(__dirname, '..', '..', 'frontend', 'build'),
  path.resolve(__dirname, '..', '..', '..', 'frontend', 'build'),
];

const resolvedBuildPath = candidateBuildPaths.find((p) =>
  fs.existsSync(path.join(p, 'index.html'))
);
const resolvedIndexPath = resolvedBuildPath ? path.join(resolvedBuildPath, 'index.html') : null;

if (resolvedBuildPath && resolvedIndexPath) {
  logger.info({ buildPath: resolvedBuildPath }, 'Serving frontend build');
  app.use(express.static(resolvedBuildPath));

  // SPA fallback — anything that isn't an API route or /health gets index.html
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
      return next();
    }
    return res.sendFile(resolvedIndexPath);
  });
} else {
  // No build present — give the user a friendly hint at / instead of a 404.
  logger.warn({ port: environment.port || 3000 }, 'No frontend build found');
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(`<!doctype html>
<html>
  <head>
    <title>Syspro Scheduler — backend only</title>
    <meta charset="utf-8" />
  </head>
  <body style="font-family: system-ui; max-width: 720px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #1f2937;">
    <h1 style="margin-bottom:.5rem;">Syspro Scheduler API</h1>
    <p style="color:#6b7280;">The backend is running, but no frontend build was found.</p>
    <h2>To see the full UI:</h2>
    <pre style="background:#f3f4f6;padding:1rem;border-radius:6px;">npm run build:frontend
:: then restart the backend</pre>
    <p>Or run the dev server with hot-reload:</p>
    <pre style="background:#f3f4f6;padding:1rem;border-radius:6px;">npm run dev:frontend
:: opens http://localhost:3001/ and proxies /api here</pre>
    <h3>API endpoints available now:</h3>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/jobs">/api/jobs</a></li>
      <li><a href="/api/resources">/api/resources</a></li>
      <li><a href="/api/status">/api/status</a></li>
    </ul>
  </body>
</html>`);
  });
}

/**
 * 404 handler — only fires for /api/* paths now (the SPA fallback above
 * already returns index.html for unknown non-API routes when a build is
 * present). For /api a missing route is a real client error.
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'No handler for this route' },
    path: req.path,
    traceId: (req as any).id || null,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Centralised error handler.
 *
 * Always returns a stable shape: { error: { code, message, details? },
 * traceId, timestamp }. Logs the full stack at ERROR with the same traceId
 * the response carries, so a planner reporting a problem can hand you the
 * traceId from their browser DevTools and you can grep the logs for it.
 *
 * Stack traces are NEVER returned to the client in production — they leak
 * implementation detail and sometimes secrets. In dev we include them so
 * the error overlay is useful.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err.status || err.statusCode) || 500;
  const code =
    err.code ||
    (status === 400
      ? 'BAD_REQUEST'
      : status === 401
      ? 'UNAUTHORIZED'
      : status === 403
      ? 'FORBIDDEN'
      : status === 404
      ? 'NOT_FOUND'
      : status === 409
      ? 'CONFLICT'
      : status === 503
      ? 'SERVICE_UNAVAILABLE'
      : 'INTERNAL_ERROR');

  const log = (req as any).log || logger;
  log.error(
    {
      err,
      status,
      code,
      path: req.path,
      method: req.method,
    },
    err.message || 'Unhandled request error'
  );

  const body: Record<string, any> = {
    error: {
      code,
      message: err.message || 'Internal Server Error',
    },
    traceId: (req as any).id || null,
    timestamp: new Date().toISOString(),
  };

  if (environment.nodeEnv !== 'production') {
    body.error.details = {
      stack: err.stack,
      cause: err.cause?.message || err.originalError?.message,
    };
  }

  res.status(status).json(body);
});

export default app;
