/*
  provision_aps_scheduler_tables.sql
  Run this ONCE against a company's SYSPRO database if the app cannot create
  its own tables at connect time (e.g. the app's SQL login lacks DDL rights).

  Creates the scheduler-owned persistence the app writes to:
    aps.SavedSchedules   — saved / approved schedules
    aps.Scenarios        — what-if scenarios
  Safe to re-run: every statement is guarded.

  (The app also creates these automatically on connect via
   ensureSysproObjects.ts — this file is only a manual fallback.)
*/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'aps')
  EXEC('CREATE SCHEMA aps');
GO

IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL
BEGIN
  CREATE TABLE aps.SavedSchedules (
    ScheduleID     nvarchar(80)  NOT NULL CONSTRAINT PK_aps_SavedSchedules PRIMARY KEY,
    ScheduleData   nvarchar(max) NOT NULL,
    Status         nvarchar(20)  NOT NULL CONSTRAINT DF_aps_SavedSchedules_Status DEFAULT ('Draft'),
    JobCount       int           NULL,
    OperationCount int           NULL,
    HorizonStart   datetime      NULL,
    HorizonEnd     datetime      NULL,
    GeneratedAt    datetime      NULL,
    SavedAt        datetime      NOT NULL CONSTRAINT DF_aps_SavedSchedules_SavedAt DEFAULT (GETDATE()),
    IsLatest       bit           NOT NULL CONSTRAINT DF_aps_SavedSchedules_IsLatest DEFAULT (0)
  );
  CREATE INDEX IX_aps_SavedSchedules_Latest ON aps.SavedSchedules (IsLatest, SavedAt DESC);
  PRINT 'aps.SavedSchedules created.';
END
ELSE PRINT 'aps.SavedSchedules already exists - skipped.';
GO

IF OBJECT_ID('aps.Scenarios', 'U') IS NULL
BEGIN
  CREATE TABLE aps.Scenarios (
    ScenarioId     nvarchar(80)  NOT NULL CONSTRAINT PK_aps_Scenarios PRIMARY KEY,
    BaseScheduleId nvarchar(80)  NULL,
    Name           nvarchar(120) NOT NULL,
    Description    nvarchar(500) NULL,
    ScheduleData   nvarchar(max) NOT NULL,
    Status         nvarchar(20)  NOT NULL CONSTRAINT DF_aps_Scenarios_Status DEFAULT ('Draft'),
    CreatedBy      nvarchar(100) NULL,
    CreatedAt      datetime2     NOT NULL CONSTRAINT DF_aps_Scenarios_CreatedAt DEFAULT (SYSUTCDATETIME()),
    PromotedAt     datetime2     NULL
  );
  CREATE INDEX IX_aps_Scenarios_Base ON aps.Scenarios (BaseScheduleId);
  PRINT 'aps.Scenarios created.';
END
ELSE PRINT 'aps.Scenarios already exists - skipped.';
GO
