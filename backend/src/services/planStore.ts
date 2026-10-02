/**
 * Plan storage in the SCHEDULER database (review §6.7).
 *
 * Plan versions (master / what-ifs / history), per-job publish status and the
 * legacy scenarios used to live in the SYSPRO company DB (aps.SavedSchedules,
 * aps.JobPublishStatus, aps.Scenarios). They now live in the SCHEDULER DB, one
 * schema per SYSPRO company: [co_<CompanyDb>].SavedSchedules, … — so SYSPRO
 * upgrades, restores and company copies never touch plan data, and the SYSPRO
 * login only needs write access for the export itself.
 *
 * The SQL is unchanged: PlanDb rewrites `aps.<Table>` to the company schema and
 * runs it on the SCHEDULER connection. On first use for a company the tables are
 * created and any rows still in the SYSPRO aps tables are copied across once
 * (the SYSPRO copies are left in place, untouched, as a fallback).
 */
import type { DbExecutor, DbParams, DbRow } from '../database/connection';
import { logger } from '../utils/logger';
import type { AppLike } from '../types/appLocals';

const PLAN_TABLES = ['SavedSchedules', 'JobPublishStatus', 'Scenarios'] as const;

export interface PlanExecutor extends DbExecutor {
  withTransaction<T>(callback: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

/** SYSPRO company DB name of a connection (DatabaseConnection keeps its config). */
export const companyDbOf = (sysproDb: unknown): string => {
  const cfg = (sysproDb as { config?: { database?: string; options?: { database?: string } } } | null)?.config;
  return String(cfg?.database || cfg?.options?.database || 'default').trim() || 'default';
};

/** Schema for a company: co_ + letters/digits/underscore only. */
export const planSchemaFor = (companyDb: string): string =>
  `co_${String(companyDb).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 120);

/** Point aps.<plan table> references (incl. inside OBJECT_ID/COL_LENGTH strings) at the company schema. */
export function rewritePlanSql(sql: string, schema: string): string {
  return sql
    .replace(new RegExp(`'aps\\.(${PLAN_TABLES.join('|')})'`, 'g'), `'${schema}.$1'`)
    .replace(new RegExp(`\\baps\\.(${PLAN_TABLES.join('|')})\\b`, 'g'), `[${schema}].$1`)
    // index / constraint names stay readable per schema
    .replace(/\b(PK|DF|IX)_aps_/g, '$1_');
}

const wrap = (inner: DbExecutor, schema: string): DbExecutor => ({
  query: <T = DbRow>(sql: string) => inner.query<T>(rewritePlanSql(sql, schema)),
  queryWithParams: <T = DbRow>(sql: string, params: DbParams) => inner.queryWithParams<T>(rewritePlanSql(sql, schema), params),
  execute: <T = DbRow>(proc: string, params?: DbParams) => inner.execute<T>(proc, params),
});

/** The SCHEDULER connection: a DbExecutor that can also run transactions. */
type TxCapableDb = PlanExecutor;

export class PlanDb implements PlanExecutor {
  private readonly x: DbExecutor;
  constructor(private schedulerDb: TxCapableDb, readonly schema: string, readonly companyDb: string) {
    this.x = wrap(schedulerDb, schema);
  }
  query<T = DbRow>(sql: string) { return this.x.query<T>(sql); }
  queryWithParams<T = DbRow>(sql: string, params: DbParams) { return this.x.queryWithParams<T>(sql, params); }
  execute<T = DbRow>(proc: string, params?: DbParams) { return this.x.execute<T>(proc, params); }
  withTransaction<T>(callback: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.schedulerDb.withTransaction((tx: DbExecutor) => callback(wrap(tx, this.schema)));
  }
}

/** DDL for the plan tables, written against aps.* and rewritten per company. */
export const PLAN_DDL: Array<{ label: string; sql: string }> = [
  {
    label: 'SavedSchedules',
    sql: `IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL
          BEGIN
            CREATE TABLE aps.SavedSchedules (
              ScheduleID     NVARCHAR(80)  NOT NULL CONSTRAINT PK_aps_SavedSchedules PRIMARY KEY,
              ScheduleData   NVARCHAR(MAX) NOT NULL,
              Status         NVARCHAR(20)  NOT NULL CONSTRAINT DF_aps_SavedSchedules_Status DEFAULT ('Draft'),
              JobCount       INT           NULL,
              OperationCount INT           NULL,
              HorizonStart   DATETIME      NULL,
              HorizonEnd     DATETIME      NULL,
              GeneratedAt    DATETIME      NULL,
              SavedAt        DATETIME      NOT NULL CONSTRAINT DF_aps_SavedSchedules_SavedAt DEFAULT (GETDATE()),
              IsLatest       BIT           NOT NULL CONSTRAINT DF_aps_SavedSchedules_IsLatest DEFAULT (0),
              VersionKind    NVARCHAR(10)  NOT NULL CONSTRAINT DF_aps_SavedSchedules_Kind DEFAULT ('Plan'),
              VersionName    NVARCHAR(120) NULL,
              BasedOnId      NVARCHAR(80)  NULL,
              CreatedBy      NVARCHAR(100) NULL,
              MetricsJson    NVARCHAR(MAX) NULL
            );
            CREATE INDEX IX_aps_SavedSchedules_Latest ON aps.SavedSchedules (IsLatest, SavedAt DESC);
          END`,
  },
  {
    // Master revision: bumped whenever the master's content changes (save,
    // generate, commit, revert) so a stale board can't overwrite a newer master.
    label: 'SavedSchedules.Revision',
    sql: `IF COL_LENGTH('aps.SavedSchedules', 'Revision') IS NULL
            ALTER TABLE aps.SavedSchedules ADD Revision INT NOT NULL
              CONSTRAINT DF_aps_SavedSchedules_Revision DEFAULT (0);`,
  },
  {
    label: 'JobPublishStatus',
    sql: `IF OBJECT_ID('aps.JobPublishStatus', 'U') IS NULL
            CREATE TABLE aps.JobPublishStatus (
              JobId          NVARCHAR(30)   NOT NULL CONSTRAINT PK_aps_JobPublishStatus PRIMARY KEY,
              ScheduleId     NVARCHAR(80)   NULL,
              Status         NVARCHAR(12)   NOT NULL,
              PlannedStart   DATETIME       NULL,
              PlannedEnd     DATETIME       NULL,
              Fingerprint    NVARCHAR(64)   NULL,
              PublishedAt    DATETIME       NULL,
              PublishedBy    NVARCHAR(100)  NULL,
              LastError      NVARCHAR(1000) NULL,
              UpdatedAt      DATETIME       NOT NULL CONSTRAINT DF_aps_JobPublishStatus_UpdatedAt DEFAULT (GETDATE())
            );`,
  },
  {
    label: 'Scenarios',
    sql: `IF OBJECT_ID('aps.Scenarios', 'U') IS NULL
            CREATE TABLE aps.Scenarios (
              ScenarioId     NVARCHAR(80)  NOT NULL CONSTRAINT PK_aps_Scenarios PRIMARY KEY,
              BaseScheduleId NVARCHAR(80)  NULL,
              Name           NVARCHAR(120) NOT NULL,
              Description    NVARCHAR(500) NULL,
              ScheduleData   NVARCHAR(MAX) NOT NULL,
              Status         NVARCHAR(20)  NOT NULL CONSTRAINT DF_aps_Scenarios_Status DEFAULT ('Draft'),
              CreatedBy      NVARCHAR(100) NULL,
              CreatedAt      DATETIME2     NOT NULL CONSTRAINT DF_aps_Scenarios_CreatedAt DEFAULT (SYSUTCDATETIME()),
              PromotedAt     DATETIME2     NULL
            );`,
  },
];

/** Columns copied from the SYSPRO aps tables (only those that exist there). */
const COPY_COLUMNS: Record<string, string[]> = {
  SavedSchedules: ['ScheduleID', 'ScheduleData', 'Status', 'JobCount', 'OperationCount', 'HorizonStart', 'HorizonEnd',
    'GeneratedAt', 'SavedAt', 'IsLatest', 'VersionKind', 'VersionName', 'BasedOnId', 'CreatedBy', 'MetricsJson'],
  JobPublishStatus: ['JobId', 'ScheduleId', 'Status', 'PlannedStart', 'PlannedEnd', 'Fingerprint', 'PublishedAt',
    'PublishedBy', 'LastError', 'UpdatedAt'],
  Scenarios: ['ScenarioId', 'BaseScheduleId', 'Name', 'Description', 'ScheduleData', 'Status', 'CreatedBy', 'CreatedAt', 'PromotedAt'],
};

/** Create the company schema + tables, then copy any legacy SYSPRO rows once. */
export async function ensurePlanStore(plan: PlanDb, sysproDb: DbExecutor | null | undefined): Promise<{ copied: Record<string, number> }> {
  await plan.query(`IF SCHEMA_ID('${plan.schema}') IS NULL EXEC('CREATE SCHEMA [${plan.schema}]');`);
  for (const d of PLAN_DDL) await plan.query(d.sql);

  const copied: Record<string, number> = {};
  if (!sysproDb) return { copied };
  for (const table of Object.keys(COPY_COLUMNS)) {
    try {
      const existing = await plan.query(`SELECT COUNT(*) AS n FROM aps.${table}`);
      if (Number(existing.recordset?.[0]?.n) > 0) continue; // already migrated / in use
      const src = await sysproDb.query(`IF OBJECT_ID('aps.${table}', 'U') IS NULL SELECT TOP 0 1 AS x; ELSE SELECT * FROM aps.${table}`);
      const rows = src.recordset || [];
      if (!rows.length || rows[0].x !== undefined) continue;
      const cols = COPY_COLUMNS[table].filter((c) => c in rows[0]);
      const insert = `INSERT INTO aps.${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`;
      await plan.withTransaction(async (tx) => {
        for (const r of rows) await tx.queryWithParams(insert, Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      });
      copied[table] = rows.length;
    } catch (err) {
      logger.warn({ err, table, schema: plan.schema }, 'Plan store: legacy copy from SYSPRO skipped');
    }
  }
  if (Object.keys(copied).length) logger.info({ schema: plan.schema, copied }, 'Plan store: copied plan data from SYSPRO aps tables');
  return { copied };
}

/**
 * Provisioned plan stores, per SCHEDULER connection and company schema. Keyed
 * by the connection object so a reconnect never reuses a PlanDb bound to a
 * closed pool (a single shared "owner" used to be checked for the first key
 * only, so switching back to a company cached earlier could hit a dead pool).
 */
let ready = new WeakMap<object, Map<string, Promise<PlanDb>>>();

/**
 * The plan store for the connected company, provisioned on first use.
 * Throws when the SCHEDULER or SYSPRO database is not connected.
 */
export async function planDbFor(app: AppLike): Promise<PlanDb> {
  const schedulerDb = app.locals.schedulerDb;
  const sysproDb = app.locals.sysproDb;
  if (!schedulerDb) throw Object.assign(new Error('Scheduler database not connected'), { status: 503 });
  const companyDb = companyDbOf(sysproDb);
  const schema = planSchemaFor(companyDb);
  let bySchema = ready.get(schedulerDb);
  if (!bySchema) ready.set(schedulerDb, (bySchema = new Map()));
  let p = bySchema.get(schema);
  if (!p) {
    const plan = new PlanDb(schedulerDb, schema, companyDb);
    const cache = bySchema;
    p = ensurePlanStore(plan, sysproDb).then(() => plan);
    p.catch(() => cache.delete(schema));
    cache.set(schema, p);
  }
  return p;
}

/** Test hook. */
export const __resetPlanStoreCache = () => { ready = new WeakMap(); };
