-- Migration 003: Sequence-dependent setup matrix
-- Stores item-to-item changeover times per workcentre.
-- Uses dbo schema (no custom schema required).

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'sch_SetupMatrix'
)
BEGIN
  CREATE TABLE dbo.sch_SetupMatrix (
    SetupId        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    WorkcentreId   NVARCHAR(50)     NOT NULL,
    FromItemCode   NVARCHAR(50)     NOT NULL,
    ToItemCode     NVARCHAR(50)     NOT NULL,
    SetupMinutes   INT              NOT NULL CHECK (SetupMinutes >= 0),
    CreatedAt      DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    UpdatedAt      DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_SCH_SetupMatrix_Changeover UNIQUE (WorkcentreId, FromItemCode, ToItemCode)
  );

  CREATE INDEX IX_SCH_SetupMatrix_WC ON dbo.sch_SetupMatrix (WorkcentreId);
  CREATE INDEX IX_SCH_SetupMatrix_From ON dbo.sch_SetupMatrix (FromItemCode, ToItemCode);

  PRINT 'dbo.sch_SetupMatrix created.';
END
ELSE
  PRINT 'dbo.sch_SetupMatrix already exists — skipped.';
