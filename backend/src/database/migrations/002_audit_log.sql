-- ============================================================
-- 002_audit_log.sql
-- Creates the sch_AuditLog table for tracking scheduler actions.
-- Applied idempotently by MigrationRunner.
-- ============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.tables
    WHERE name = 'sch_AuditLog' AND type = 'U'
)
BEGIN
    CREATE TABLE sch_AuditLog (
        auditId      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
        actorId      NVARCHAR(128)    NOT NULL,              -- userId or 'system'
        action       NVARCHAR(64)     NOT NULL,              -- 'approve', 'export', 'override', 'reschedule', etc.
        entityType   NVARCHAR(64)     NOT NULL,              -- 'schedule', 'operation', 'job', etc.
        entityId     NVARCHAR(256)    NOT NULL,              -- scheduleId, jobId, opId, etc.
        before       NVARCHAR(MAX)    NULL,                  -- JSON snapshot before the action
        after        NVARCHAR(MAX)    NULL,                  -- JSON snapshot after the action
        traceId      NVARCHAR(128)    NULL,                  -- correlates to pino-http traceId
        ts           DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
    );

    CREATE INDEX IX_AuditLog_actor  ON sch_AuditLog (actorId, ts DESC);
    CREATE INDEX IX_AuditLog_entity ON sch_AuditLog (entityType, entityId, ts DESC);
END
GO
