-- Migration 009: ProductClass-level changeover matrix
-- Stores sequence-dependent changeover time between SYSPRO product classes.
-- The scheduler expands these into item->item setup times at generation time
-- using each item's InvMaster.ProductClass. Uses dbo schema.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'sch_ClassChangeover'
)
BEGIN
  CREATE TABLE dbo.sch_ClassChangeover (
    Id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    FromClass    NVARCHAR(50)     NOT NULL,
    ToClass      NVARCHAR(50)     NOT NULL,
    SetupMinutes INT              NOT NULL CHECK (SetupMinutes >= 0),
    CreatedAt    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt    DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_sch_ClassChangeover UNIQUE (FromClass, ToClass)
  );
  CREATE INDEX IX_sch_ClassChangeover_From ON dbo.sch_ClassChangeover (FromClass, ToClass);
  PRINT 'dbo.sch_ClassChangeover created.';
END
ELSE
  PRINT 'dbo.sch_ClassChangeover already exists - skipped.';
