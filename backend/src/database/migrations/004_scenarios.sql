-- Migration 004: Scenario branching table
-- Allows named clones of a base schedule for what-if comparison.
-- Uses dbo schema (no custom schema required).

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'sch_Scenarios'
)
BEGIN
  CREATE TABLE dbo.sch_Scenarios (
    ScenarioId    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    BaseScheduleId UNIQUEIDENTIFIER NULL,
    Name          NVARCHAR(120)    NOT NULL,
    Description   NVARCHAR(500)    NULL,
    ScheduleData  NVARCHAR(MAX)    NOT NULL,  -- JSON clone of the base schedule
    Status        NVARCHAR(20)     NOT NULL DEFAULT 'Draft'
                    CHECK (Status IN ('Draft', 'Promoted', 'Archived')),
    CreatedBy     NVARCHAR(100)    NULL,
    CreatedAt     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    PromotedAt    DATETIME2        NULL
  );

  CREATE INDEX IX_SCH_Scenarios_Base ON dbo.sch_Scenarios (BaseScheduleId);
  PRINT 'dbo.sch_Scenarios created.';
END
ELSE
  PRINT 'dbo.sch_Scenarios already exists — skipped.';
