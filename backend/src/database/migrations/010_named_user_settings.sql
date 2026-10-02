-- Migration 010: settings for users without a dbo.lic_users row
-- Windows (NTLM) sign-ins have no numeric user id, so their personal settings
-- and job-grid column profile are stored by sign-in name instead
-- (e.g. 'ntlm:DOMAIN\user'). Uses dbo schema.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'sch_NamedUserSettings'
)
BEGIN
  CREATE TABLE dbo.sch_NamedUserSettings (
    UserKey        NVARCHAR(256) NOT NULL PRIMARY KEY,
    SettingsJson   NVARCHAR(MAX) NULL,
    ColumnProfile  NVARCHAR(MAX) NULL,
    UpdatedAt      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  PRINT 'dbo.sch_NamedUserSettings created.';
END
ELSE
  PRINT 'dbo.sch_NamedUserSettings already exists - skipped.';
