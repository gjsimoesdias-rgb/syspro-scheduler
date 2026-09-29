-- ============================================================
-- Add column_profile to lic_users so each user can persist
-- their job-table column order / visibility as a named profile.
-- ============================================================

IF NOT EXISTS (
  SELECT * FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'lic_users' AND COLUMN_NAME = 'column_profile'
)
BEGIN
  ALTER TABLE [dbo].[lic_users]
    ADD [column_profile] NVARCHAR(MAX) NULL;
  PRINT 'Added column_profile to lic_users';
END
GO
