-- ============================================================
-- License & User Management Schema for SCHEDULER database
-- Run against the SCHEDULER database (connection is already
-- pointing to SCHEDULER when MigrationRunner executes this).
-- ============================================================

-- ── LICENSES ──────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_licenses')
BEGIN
  CREATE TABLE [dbo].[lic_licenses] (
    [id]            INT IDENTITY(1,1) PRIMARY KEY,
    [license_key]   NVARCHAR(64)  NOT NULL,
    [company_name]  NVARCHAR(200) NOT NULL,
    [contact_email] NVARCHAR(200) NULL,
    [max_users]     INT           NOT NULL DEFAULT 5,
    [is_active]     BIT           NOT NULL DEFAULT 1,
    [expiry_date]   DATE          NULL,
    [plan]          NVARCHAR(50)  NOT NULL DEFAULT 'standard',
    [notes]         NVARCHAR(MAX) NULL,
    [created_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    [updated_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT [UQ_lic_licenses_key] UNIQUE ([license_key])
  );
  PRINT 'Created table lic_licenses';
END
GO

-- ── COMPANIES ─────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_companies')
BEGIN
  CREATE TABLE [dbo].[lic_companies] (
    [id]         INT IDENTITY(1,1) PRIMARY KEY,
    [license_id] INT           NOT NULL REFERENCES [dbo].[lic_licenses]([id]),
    [name]       NVARCHAR(200) NOT NULL,
    [syspro_company_id] NVARCHAR(50) NULL,
    [created_at] DATETIME      NOT NULL DEFAULT GETDATE()
  );
  PRINT 'Created table lic_companies';
END
GO

-- ── USERS ─────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_users')
BEGIN
  CREATE TABLE [dbo].[lic_users] (
    [id]            INT IDENTITY(1,1) PRIMARY KEY,
    [company_id]    INT           NULL REFERENCES [dbo].[lic_companies]([id]),
    [username]      NVARCHAR(100) NOT NULL,
    [email]         NVARCHAR(200) NOT NULL,
    [password_hash] NVARCHAR(255) NOT NULL,
    [role]          NVARCHAR(50)  NOT NULL DEFAULT 'planner',
    [full_name]     NVARCHAR(200) NULL,
    [is_active]     BIT           NOT NULL DEFAULT 1,
    [last_login]    DATETIME      NULL,
    [created_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    [updated_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT [UQ_lic_users_username] UNIQUE ([username]),
    CONSTRAINT [UQ_lic_users_email]    UNIQUE ([email]),
    CONSTRAINT [CK_lic_users_role]     CHECK  ([role] IN ('super_admin','company_admin','planner','viewer'))
  );
  PRINT 'Created table lic_users';
END
GO

-- ── REFRESH TOKEN SESSIONS ────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_sessions')
BEGIN
  CREATE TABLE [dbo].[lic_sessions] (
    [id]            INT IDENTITY(1,1) PRIMARY KEY,
    [user_id]       INT           NOT NULL REFERENCES [dbo].[lic_users]([id]) ON DELETE CASCADE,
    [refresh_token] NVARCHAR(512) NOT NULL,
    [expires_at]    DATETIME      NOT NULL,
    [created_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT [UQ_lic_sessions_token] UNIQUE ([refresh_token])
  );
  PRINT 'Created table lic_sessions';
END
GO

-- ── COMPANY SETTINGS ──────────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_company_settings')
BEGIN
  CREATE TABLE [dbo].[lic_company_settings] (
    [id]            INT IDENTITY(1,1) PRIMARY KEY,
    [company_id]    INT           NOT NULL REFERENCES [dbo].[lic_companies]([id]) ON DELETE CASCADE,
    [settings_json] NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    [updated_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    [updated_by]    INT           NULL REFERENCES [dbo].[lic_users]([id]),
    CONSTRAINT [UQ_lic_company_settings_cid] UNIQUE ([company_id])
  );
  PRINT 'Created table lic_company_settings';
END
GO

-- ── USER SETTINGS ─────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lic_user_settings')
BEGIN
  CREATE TABLE [dbo].[lic_user_settings] (
    [id]            INT IDENTITY(1,1) PRIMARY KEY,
    [user_id]       INT           NOT NULL REFERENCES [dbo].[lic_users]([id]) ON DELETE CASCADE,
    [settings_json] NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    [updated_at]    DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT [UQ_lic_user_settings_uid] UNIQUE ([user_id])
  );
  PRINT 'Created table lic_user_settings';
END
GO

PRINT 'Migration 001_auth_licensing complete.';
GO
