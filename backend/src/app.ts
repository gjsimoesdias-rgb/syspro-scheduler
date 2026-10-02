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
import versionsRoutes from './api/routes/versions';
import shopfloorRoutes from './api/routes/shopfloor';
import rateLimit from 'express-rate-limit';
import environment from './config/environment';
import { httpLogger, logger } from './utils/logger';
import { errorMessage, errorStatus, errorCode } from './utils/errors';
import { requireAuth, requireCompanyAdmin, requireShopfloorAccess } from './api/middleware/requireAuth';

const app: Express = express();

// Middleware
app.use(helmet());
// The UI is served from this same origin (and Vite's dev server proxies /api),
// so no CORS headers are needed. Only a UI hosted elsewhere needs them:
// CORS_ORIGINS=https://planner.example.com,https://other.example.com
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (corsOrigins.length) app.use(cors({ origin: corsOrigins }));
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

// Rate limiting. Only the expensive or guessable endpoints are limited — the
// board polls /latest, /pins, /publish-status and autosaves on every edit, so a
// limit on all of /api/schedule would lock planners out in production.
const isProd = process.env.NODE_ENV === 'production';

// Generate / optimize / auto-run / export: CPU- or SYSPRO-heavy runs.
const scheduleRunRateLimit = rateLimit({
  windowMs: 60_000,
  max: isProd ? 10 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many schedule runs, please wait a minute.' },
});

// Password guessing: only failed logins count.
const loginRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: isProd ? 20 : 10_000,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed sign-in attempts, please try again later.' },
});

// Refresh / logout / me / NTLM handshake: generous, just a flood guard.
const sessionRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: isProd ? 600 : 10_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests, please try again later.' },
});

// API routes
// Public: auth (login / refresh / logout / NTLM handshake), health, shopfloor
app.post('/api/auth/login', loginRateLimit);
app.use('/api/auth', sessionRateLimit, authRoutes);
app.use('/api/auth/ntlm', ntlmAuthRoutes); // already rate-limited by the /api/auth mount above
// Shop-floor wall screens: a signed-in user, or the shop-floor key from the
// screen link (Settings → Shop-floor screen). Read-only, today's ops only.
app.use('/api/shopfloor', requireShopfloorAccess, shopfloorRoutes);

// Protected: all remaining routes require a valid JWT
app.use('/api/schedule', eventsRoutes);   // SSE events stream — public, EventSource can't send headers; MUST be before requireAuth
for (const runPath of ['/api/schedule/generate', '/api/schedule/optimize', '/api/schedule/auto/run', '/api/schedule/:scheduleId/export-to-syspro']) {
  app.post(runPath, scheduleRunRateLimit);
}
app.use('/api/schedule', requireAuth, scheduleRoutes);
app.use('/api/jobs', requireAuth, jobRoutes);
app.use('/api/resources', requireAuth, resourceRoutes);
// /databases and /connect can list databases, reconnect the whole server and
// rewrite backend/.env, so they are tightly gated:
//   - first-run (no DB connected yet): allowed without a login, but ONLY from
//     the server itself (localhost) — nobody else on the LAN can repoint the app
//   - once connected: a signed-in super_admin or company_admin only
// Every other /api/status route needs a normal login.
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocalRequest = (req: Request): boolean =>
  LOCAL_ADDRESSES.has(req.socket.remoteAddress || '');

app.use('/api/status', (req: Request, res: Response, next: NextFunction) => {
  const isSetupRoute = req.path === '/databases' || req.path === '/connect';
  if (!isSetupRoute) return requireAuth(req, res, next);

  const firstRun = !req.app.locals.sysproDb || !req.app.locals.schedulerDb;
  if (firstRun && isLocalRequest(req)) return next();
  if (firstRun && !req.headers.authorization) {
    return res.status(403).json({
      error: 'Database setup can only be done on the server PC itself (http://localhost:' +
        environment.port + '/) until the scheduler is connected.',
    });
  }
  return requireAuth(req, res, () => requireCompanyAdmin(req, res, next));
}, statusRoutes);
app.use('/api/inventory', requireAuth, inventoryRoutes);
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/licenses', requireAuth, licenseRoutes);
app.use('/api/settings', requireAuth, appSettingsRoutes);
app.use('/api/audit', requireAuth, auditRoutes);
app.use('/api/scenarios', requireAuth, scenariosRoutes);
app.use('/api/versions', requireAuth, versionsRoutes);

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
    traceId: req.id ?? null,
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
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = errorStatus(err) || 500;
  const code =
    errorCode(err) ||
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

  const log = req.log || logger;
  log.error(
    {
      err,
      status,
      code,
      path: req.path,
      method: req.method,
    },
    errorMessage(err, 'Unhandled request error')
  );

  const body: {
    error: { code: string; message: string; details?: { stack?: string; cause?: string } };
    traceId: unknown;
    timestamp: string;
  } = {
    error: {
      code,
      message: errorMessage(err, 'Internal Server Error'),
    },
    traceId: req.id ?? null,
    timestamp: new Date().toISOString(),
  };

  if (environment.nodeEnv !== 'production') {
    const e = err as { stack?: string; cause?: unknown; originalError?: unknown } | null;
    body.error.details = {
      stack: e?.stack,
      cause: e?.cause ? errorMessage(e.cause) : e?.originalError ? errorMessage(e.originalError) : undefined,
    };
  }

  res.status(status).json(body);
});

export default app;
