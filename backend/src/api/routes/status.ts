/**
 * Status API routes
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import DatabaseConnection from '../../database/connection';
import { MigrationRunner } from '../../database/MigrationRunner';
import { ensureSysproObjects } from '../../database/ensureSysproObjects';
import { planDbFor } from '../../services/planStore';
import AuthService from '../../services/AuthService';
import { loadCompanyState } from '../../services/companyState';
import { validateBody } from '../middleware/validateBody';
import { requireCompanyAdmin } from '../middleware/requireAuth';
import { SHOPFLOOR_KEY } from '../../config/secrets';
import { listDatabasesSchema, connectSchema } from '../validators/statusValidators';
import { errorMessage } from '../../utils/errors';

const router = Router();
const ENV_PATH = path.resolve(process.cwd(), '.env');

const formatEnvValue = (value: unknown): string => {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /[\s#"']/g.test(text) ? JSON.stringify(text) : text;
};

const upsertEnvValue = (envContent: string, key: string, value: unknown): string => {
  const nextLine = `${key}=${formatEnvValue(value)}`;
  const matcher = new RegExp(`^${key}=.*$`, 'm');

  if (matcher.test(envContent)) {
    return envContent.replace(matcher, nextLine);
  }

  const prefix = envContent.trimEnd();
  return `${prefix}${prefix ? '\n' : ''}${nextLine}\n`;
};

const persistConnectionProfile = (payload: any, database: string, schedulerDatabase: string | null) => {
  let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';

  const updates: Record<string, unknown> = {
    SYSPRO_DB_SERVER: String(payload?.server || 'localhost').trim() || 'localhost',
    SYSPRO_DB_INSTANCE: String(payload?.instanceName || '').trim(),
    SYSPRO_DB_PORT: payload?.port ? Number(payload.port) : '',
    SYSPRO_DB_NAME: database,
    SYSPRO_DB_AUTH_MODE: String(payload?.authMode || 'sql').toLowerCase(),
    SYSPRO_DB_USER: String(payload?.userName || payload?.username || '').trim(),
    SYSPRO_DB_PASSWORD: String(payload?.password || ''),
    SCHEDULER_DB_SERVER: String(payload?.server || 'localhost').trim() || 'localhost',
    SCHEDULER_DB_INSTANCE: String(payload?.instanceName || '').trim(),
    SCHEDULER_DB_PORT: payload?.port ? Number(payload.port) : '',
    SCHEDULER_DB_NAME: schedulerDatabase || 'SCHEDULER',
    SCHEDULER_DB_AUTH_MODE: String(payload?.authMode || 'sql').toLowerCase(),
    SCHEDULER_DB_USER: String(payload?.userName || payload?.username || '').trim(),
    SCHEDULER_DB_PASSWORD: String(payload?.password || '')
  };

  for (const [key, value] of Object.entries(updates)) {
    envContent = upsertEnvValue(envContent, key, value);
  }

  fs.writeFileSync(ENV_PATH, envContent, 'utf8');
};
const buildConnectionConfig = (payload: any, databaseOverride?: string) => {
  const authMode = String(payload?.authMode || 'sql').toLowerCase();
  const server = String(payload?.server || 'localhost').trim() || 'localhost';
  const database = String(databaseOverride || payload?.database || 'master').trim() || 'master';
  const port = payload?.port ? Number(payload.port) : undefined;
  const instanceName = String(payload?.instanceName || '').trim();

  const config: any = {
    server,
    database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      connectTimeout: 30000
    }
  };

  // Always set instanceName when provided so SQL Browser can resolve the
  // dynamic port. If an explicit port is also given it takes precedence.
  if (instanceName && authMode !== 'windows') {
    config.options.instanceName = instanceName;
  }
  if (port) {
    config.port = port;
  }

  if (authMode === 'windows') {
    config.options.trustedConnection = true;
  } else {
    config.authentication = {
      type: 'default',
      options: {
        userName: String(payload?.userName || payload?.username || ''),
        password: String(payload?.password || '')
      }
    };
  }

  return config;
};

// ── Schema introspection (live database diagram) ────────────────────────────

/** Render an mssql sys.types row into a human-friendly SQL type string. */
const formatColumnType = (row: any): string => {
  const t = String(row.typeName || '').toLowerCase();
  const len = Number(row.max_length);
  const prec = Number(row.precision);
  const scale = Number(row.scale);

  if (['varchar', 'char', 'varbinary', 'binary'].includes(t)) {
    return `${t}(${len === -1 ? 'max' : len})`;
  }
  if (['nvarchar', 'nchar'].includes(t)) {
    // nvarchar/nchar max_length is in bytes → divide by 2 for character count.
    return `${t}(${len === -1 ? 'max' : Math.floor(len / 2)})`;
  }
  if (['decimal', 'numeric'].includes(t)) {
    return `${t}(${prec},${scale})`;
  }
  return t;
};

/**
 * Introspect a single connected database and return its tables, views,
 * columns (with PK flags) and foreign-key relationships. Reads only the
 * system catalog — no user data is touched.
 */
const introspectDatabase = async (
  db: any,
  role: 'syspro' | 'scheduler',
  name: string
) => {
  // Objects: user tables (U) and views (V).
  const objectsRes = await db.query(`
    SELECT o.object_id AS objectId, s.name AS schemaName, o.name AS objName,
           CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS objType
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
    ORDER BY s.name, o.name
  `);

  // Columns for every table/view.
  const columnsRes = await db.query(`
    SELECT c.object_id AS objectId, c.column_id AS columnId, c.name AS colName,
           ty.name AS typeName, c.max_length, c.precision, c.scale, c.is_nullable
    FROM sys.columns c
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    ORDER BY c.object_id, c.column_id
  `);

  // Primary-key columns.
  const pkRes = await db.query(`
    SELECT ic.object_id AS objectId, ic.column_id AS columnId
    FROM sys.index_columns ic
    JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    WHERE i.is_primary_key = 1
  `);

  // Foreign-key relationships (tables only).
  const fkRes = await db.query(`
    SELECT fk.name AS fkName,
           ps.name AS fromSchema, pt.name AS fromTable, pc.name AS fromColumn,
           rs.name AS toSchema,  rt.name AS toTable,  rc.name AS toColumn
    FROM sys.foreign_key_columns fkc
    JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
    JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
    JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
    JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
  `);

  // Approximate row counts (heap or clustered index only). Cheap, no scan.
  let rowCounts = new Map<number, number>();
  try {
    const rowsRes = await db.query(`
      SELECT p.object_id AS objectId, SUM(p.row_count) AS rows
      FROM sys.dm_db_partition_stats p
      WHERE p.index_id IN (0, 1)
      GROUP BY p.object_id
    `);
    rowCounts = new Map(
      rowsRes.recordset.map((r: any) => [Number(r.objectId), Number(r.rows)] as [number, number])
    );
  } catch {
    // VIEW_DATABASE_STATE may be denied for the login — row counts are optional.
  }

  const pkSet = new Set(
    pkRes.recordset.map((r: any) => `${r.objectId}:${r.columnId}`)
  );

  const colsByObject = new Map<number, any[]>();
  for (const c of columnsRes.recordset) {
    const list = colsByObject.get(Number(c.objectId)) || [];
    list.push({
      name: c.colName,
      type: formatColumnType(c),
      nullable: !!c.is_nullable,
      pk: pkSet.has(`${c.objectId}:${c.columnId}`),
    });
    colsByObject.set(Number(c.objectId), list);
  }

  const objects = objectsRes.recordset.map((o: any) => ({
    schema: o.schemaName,
    name: o.objName,
    type: o.objType as 'table' | 'view',
    rows: rowCounts.has(Number(o.objectId)) ? rowCounts.get(Number(o.objectId)) : undefined,
    columns: colsByObject.get(Number(o.objectId)) || [],
  }));

  const relationships = fkRes.recordset.map((r: any) => ({
    name: r.fkName,
    fromSchema: r.fromSchema,
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toSchema: r.toSchema,
    toTable: r.toTable,
    toColumn: r.toColumn,
  }));

  return {
    name,
    role,
    tableCount: objects.filter((o: any) => o.type === 'table').length,
    viewCount: objects.filter((o: any) => o.type === 'view').length,
    objects,
    relationships,
  };
};

/**
 * GET /api/status/schema
 * Live-introspected schema (databases → tables/views → columns + FK edges)
 * for every currently-connected database. Backs the HOME → Schema diagram.
 */
router.get('/schema', async (req: Request, res: Response) => {
  const sysproDb = req.app.locals.sysproDb;
  const schedulerDb = req.app.locals.schedulerDb;
  const profile = req.app.locals.connectionProfile || {};

  if (!sysproDb && !schedulerDb) {
    return res.status(409).json({ error: 'No database is connected. Open a company first.' });
  }

  try {
    const databases: any[] = [];
    if (sysproDb) {
      databases.push(await introspectDatabase(sysproDb, 'syspro', profile.database || 'SYSPRO'));
    }
    // Only introspect the scheduler DB separately when it is a distinct database.
    if (
      schedulerDb &&
      profile.schedulerDatabase &&
      profile.schedulerDatabase !== profile.database
    ) {
      databases.push(await introspectDatabase(schedulerDb, 'scheduler', profile.schedulerDatabase));
    }
    res.json({ databases, generatedAt: new Date().toISOString() });
  } catch (error) {
    req.log?.error({ err: error }, 'Schema introspection failed');
    res.status(500).json({ error: errorMessage(error, 'Failed to introspect database schema') });
  }
});

router.get('/', async (req: Request, res: Response) => {
  const sysproConnected = !!req.app.locals.sysproDb;
  const schedulerConnected = !!req.app.locals.schedulerDb;
  const profile = req.app.locals.connectionProfile || null;

  res.json({
    sysproConnected,
    schedulerConnected,
    readOnly: !sysproConnected || !schedulerConnected,
    profile,
    message: sysproConnected
      ? schedulerConnected
        ? 'All systems connected'
        : 'Scheduler database is unavailable; exports are disabled'
      : 'Database not connected - running in read-only mode'
  });
});

/**
 * GET /api/status/engines
 * Availability of each scheduling engine. Greedy runs in-process (always
 * available); CP-SAT depends on the Python sidecar being up.
 */
router.get('/engines', async (_req: Request, res: Response) => {
  const sidecarUrl = process.env.CP_SAT_URL || 'http://localhost:5050';
  const cpSat: { available: boolean; detail?: string } = { available: false };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${sidecarUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);

    if (resp.ok) {
      const body = (await resp.json()) as { ortools_available?: boolean };
      if (body?.ortools_available === false) {
        cpSat.detail = 'Sidecar reachable but OR-Tools is not installed';
      } else {
        cpSat.available = true;
      }
    } else {
      cpSat.detail = `CP-SAT sidecar responded with HTTP ${resp.status}`;
    }
  } catch {
    cpSat.detail = `CP-SAT sidecar unreachable at ${sidecarUrl}`;
  }

  res.json({
    engines: {
      greedy: { available: true },
      'cp-sat': cpSat,
    },
  });
});

/**
 * GET /api/status/shopfloor-link — the wall-screen link (company admin).
 * Path only; the UI adds its own origin.
 */
router.get('/shopfloor-link', requireCompanyAdmin, (_req: Request, res: Response) => {
  res.json({ path: `/shopfloor?key=${encodeURIComponent(SHOPFLOOR_KEY)}` });
});

router.post('/databases', validateBody(listDatabasesSchema), async (req: Request, res: Response) => {
  let tempDb: DatabaseConnection | null = null;
  try {
    tempDb = new DatabaseConnection(buildConnectionConfig(req.body, 'master') as any);
    await tempDb.connect();
    const result = await tempDb.query(`
      SELECT name
      FROM sys.databases
      WHERE database_id > 4 AND state_desc = 'ONLINE'
      ORDER BY name ASC
    `);
    res.json({ databases: result.recordset.map((row: any) => row.name) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error, 'Failed to load company databases') });
  } finally {
    if (tempDb) {
      await tempDb.disconnect().catch(() => undefined);
    }
  }
});

router.post('/connect', validateBody(connectSchema), async (req: Request, res: Response) => {
  let nextSysproDb: DatabaseConnection | null = null;
  let nextSchedulerDb: DatabaseConnection | null = null;
  // Once a new pool is live in app.locals it must never be closed by the
  // error path below (the old pool is already gone by then).
  let sysproLive = false;
  let schedulerLive = false;

  try {
    const payload = req.body;
    const database = String(payload.database || '').trim();
    if (!database) {
      return res.status(400).json({ error: 'Company / database is required' });
    }

    nextSysproDb = new DatabaseConnection(buildConnectionConfig(payload, database) as any);
    await nextSysproDb.connect();

    const schedulerDatabase = String(payload.schedulerDatabase || req.app.locals.connectionProfile?.schedulerDatabase || '').trim();
    if (schedulerDatabase) {
      nextSchedulerDb = new DatabaseConnection(buildConnectionConfig(payload, schedulerDatabase) as any);
      await nextSchedulerDb.connect();
    }

    if (req.app.locals.sysproDb) {
      await req.app.locals.sysproDb.disconnect().catch(() => undefined);
    }
    req.app.locals.sysproDb = nextSysproDb;
    sysproLive = true;

    // Provision the scheduler-owned aps objects (aps.SavedSchedules,
    // aps.Scenarios) in the newly-connected company's SYSPRO DB. Runtime
    // company switches go through here, not server.ts startup, so this must run
    // on every /connect. Idempotent; non-fatal if the login lacks DDL rights.
    try {
      await ensureSysproObjects(nextSysproDb);
    } catch (ensureErr) {
      req.log.warn({ err: ensureErr }, 'Could not ensure Syspro scheduler objects during connect');
    }

    let initialAdmin: { username: string; password: string } | null = null;
    if (nextSchedulerDb) {
      if (req.app.locals.schedulerDb) {
        await req.app.locals.schedulerDb.disconnect().catch(() => undefined);
      }
      req.app.locals.schedulerDb = nextSchedulerDb;
      schedulerLive = true;

      // Run migrations and seed default admin whenever a new scheduler DB is
      // connected at runtime (covers fresh-install flow where no .env existed
      // at startup, so server.ts background init never had a chance to run).
      try {
        const migrationsDir = path.resolve(__dirname, '../../database/migrations');
        const runner = new MigrationRunner(nextSchedulerDb);
        await runner.run(migrationsDir);
      } catch (migErr) {
        req.log.warn({ err: migErr }, 'Migration warning during connect');
      }
      try {
        const authSvc = new AuthService(nextSchedulerDb);
        initialAdmin = await authSvc.seedDefaultAdmin();
      } catch (seedErr) {
        req.log.warn({ err: seedErr }, 'Seed warning during connect');
      }
    }

    // Load the newly connected company's state (pins, shifts, crews, markers…)
    // — also when only the SYSPRO company changed, so nothing carries across.
    try {
      await loadCompanyState(req.app);
    } catch (stateErr) {
      req.log.warn({ err: stateErr }, 'AppState warning during connect');
    }

    // Plan store for the newly connected company (SCHEDULER DB schema co_<db>).
    try {
      await planDbFor(req.app);
    } catch (planErr) {
      req.log.warn({ err: planErr }, 'Plan store warning during connect');
    }

    req.app.locals.connectionProfile = {
      server: String(payload.server || 'localhost'),
      database,
      schedulerDatabase: schedulerDatabase || null,
      authMode: String(payload.authMode || 'sql').toLowerCase(),
      userName: String(payload.userName || payload.username || ''),
      instanceName: String(payload.instanceName || ''),
      port: payload.port ? Number(payload.port) : null
    };

    // Saving to .env is for the next launch; failing to write it must not
    // undo a connection that is already live.
    let profileSaved = true;
    try {
      persistConnectionProfile(payload, database, schedulerDatabase || null);
    } catch (envErr) {
      profileSaved = false;
      req.log.warn({ err: envErr }, 'Connected, but backend/.env could not be updated');
    }

    res.json({
      connected: true,
      sysproConnected: true,
      schedulerConnected: !!req.app.locals.schedulerDb,
      profile: req.app.locals.connectionProfile,
      message: profileSaved
        ? `Connected to ${database}. Settings saved for the next launch.`
        : `Connected to ${database}, but the settings could not be saved to backend/.env — the next launch will use the old connection.`,
      // Only present when this request created the very first admin user on a
      // brand-new scheduler DB (first-run, localhost-only — see app.ts).
      ...(initialAdmin ? { initialAdmin } : {})
    });
  } catch (error) {
    if (nextSysproDb && !sysproLive) {
      await nextSysproDb.disconnect().catch(() => undefined);
    }
    if (nextSchedulerDb && !schedulerLive) {
      await nextSchedulerDb.disconnect().catch(() => undefined);
    }
    res.status(500).json({ error: errorMessage(error, 'Failed to connect to database') });
  }
});

export default router;
