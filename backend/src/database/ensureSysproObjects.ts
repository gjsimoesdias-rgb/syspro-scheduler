/**
 * ensureSysproObjects — idempotently create the scheduler-owned objects the app
 * writes into the SYSPRO company database (the `aps` schema).
 *
 * These tables (aps.SavedSchedules, aps.Scenarios) are the scheduler's OWN
 * persistence — not LYNQ mirror objects — so they must exist in every company
 * DB the app connects to. The LYNQ compatibility mirror objects
 * (aps.SourceProductionOrders, views, procs, …) are provisioned separately by
 * create_aps_lynq_compat_objects.sql.
 *
 * Every statement is guarded (IF NOT EXISTS / OBJECT_ID IS NULL) so this is safe
 * to run on every connect, including against a brand-new company DB. Failures
 * are thrown to the caller, which logs and continues in degraded mode.
 */
import type DatabaseConnection from './connection';
import { logger } from '../utils/logger';

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: "schema 'aps'",
    sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'aps')
            EXEC('CREATE SCHEMA aps');`,
  },
  {
    label: 'aps.SavedSchedules',
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
              IsLatest       BIT           NOT NULL CONSTRAINT DF_aps_SavedSchedules_IsLatest DEFAULT (0)
            );
            CREATE INDEX IX_aps_SavedSchedules_Latest ON aps.SavedSchedules (IsLatest, SavedAt DESC);
          END`,
  },
  {
    label: 'aps.Scenarios',
    sql: `IF OBJECT_ID('aps.Scenarios', 'U') IS NULL
          BEGIN
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
            );
            CREATE INDEX IX_aps_Scenarios_Base ON aps.Scenarios (BaseScheduleId);
          END`,
  },
];

/**
 * Ensure the scheduler-owned aps objects exist in the connected SYSPRO database.
 * Runs each guarded DDL statement in its own batch. Throws on the first failure.
 */
export async function ensureSysproObjects(db: DatabaseConnection): Promise<void> {
  for (const { label, sql } of STATEMENTS) {
    try {
      await db.query(sql);
    } catch (err: any) {
      logger.error({ err, object: label }, `ensureSysproObjects: failed to ensure ${label}`);
      throw err;
    }
  }
  logger.info({ count: STATEMENTS.length }, 'ensureSysproObjects: scheduler-owned aps objects ensured');
}

export default ensureSysproObjects;
