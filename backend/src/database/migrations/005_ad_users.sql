-- ============================================================
-- Windows AD User Role Assignments
-- Run against the SCHEDULER database
-- Migration 005 — created 2026-05-11
-- ============================================================

-- (connected to SCHEDULER already)
GO

-- ── AD User role table ────────────────────────────────────
IF OBJECT_ID('dbo.sch_ADUsers', 'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[sch_ADUsers] (
    [username]    NVARCHAR(100) NOT NULL,   -- Windows username, lowercase, no domain prefix
    [domain]      NVARCHAR(50)  NOT NULL DEFAULT '',
    [role]        NVARCHAR(20)  NOT NULL DEFAULT 'Reviewer'
                  CONSTRAINT [CHK_sch_ADUsers_role]
                    CHECK ([role] IN ('Reviewer', 'Approver', 'super_admin')),
    [full_name]   NVARCHAR(200) NULL,
    [email]       NVARCHAR(200) NULL,
    [last_seen]   DATETIME2     NULL,
    [created_at]  DATETIME2     NOT NULL DEFAULT GETDATE(),
    CONSTRAINT [PK_sch_ADUsers] PRIMARY KEY ([username], [domain])
  );
  PRINT 'Created table sch_ADUsers';
END
ELSE
BEGIN
  PRINT 'Table sch_ADUsers already exists — skipped.';
END
GO

-- ── Index for fast role look-up by username ───────────────
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE  object_id = OBJECT_ID('dbo.sch_ADUsers')
    AND  name = 'IX_sch_ADUsers_username'
)
BEGIN
  CREATE INDEX [IX_sch_ADUsers_username]
    ON [dbo].[sch_ADUsers] ([username]);
  PRINT 'Created index IX_sch_ADUsers_username';
END
GO
