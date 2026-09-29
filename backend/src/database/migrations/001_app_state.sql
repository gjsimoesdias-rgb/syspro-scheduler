/*
 * Migration 001 — sch_AppState
 *
 * One key-value table that backs every piece of mutable state the
 * scheduler used to keep only in `app.locals` (importedJobs,
 * importedOperations, resourceDefinitions, shiftTemplates,
 * constraintOverrides).
 *
 * payload is stored as JSON in NVARCHAR(MAX) — schedule volumes are
 * tiny and JSON keeps the schema flexible while the front-end shapes
 * are still settling. We can split into typed tables once those are
 * stable.
 *
 * Run once per environment:
 *   sqlcmd -S <SCHEDULER_DB_SERVER> -d <SCHEDULER_DB_NAME> -i 001_app_state.sql
 *
 * The backend also calls AppStateStore.ensureTable() at startup, which
 * applies this DDL idempotently if the table is missing.
 */

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = N'sch_AppState')
BEGIN
  CREATE TABLE sch_AppState (
    stateKey   NVARCHAR(100) NOT NULL PRIMARY KEY,
    payload    NVARCHAR(MAX) NOT NULL,
    updatedAt  DATETIME2     NOT NULL CONSTRAINT DF_sch_AppState_updatedAt DEFAULT SYSUTCDATETIME(),
    updatedBy  NVARCHAR(100) NULL
  );
END;
GO
