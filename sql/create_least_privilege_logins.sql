/* =============================================================================
   Least-privilege SQL logins for the SYSPRO Scheduler (replaces 'sa')
   -----------------------------------------------------------------------------
   Run once in SSMS as a sysadmin, on the SQL instance that holds both databases.
   Safe to re-run (every step checks first).

   Creates:
     aps_scheduler  -> SCHEDULER DB: read/write + DDL (for the app's migrations)
     aps_syspro     -> SYSPRO company DB:
                         - read everything in dbo
                         - full rights on the scheduler-owned [aps] schema
                         - UPDATE only on the WipMaster / WipJobAllLab columns
                           the "Send to SYSPRO" export writes

   Afterwards, in backend\.env:
     SYSPRO_DB_USER=aps_syspro        SYSPRO_DB_PASSWORD=<password 2>
     SCHEDULER_DB_USER=aps_scheduler  SCHEDULER_DB_PASSWORD=<password 1>
   then restart the scheduler, and change the 'sa' password.
   ============================================================================= */

-- ▼▼▼ Defaults match this install — just press F5. ▼▼▼
-- Leave the passwords empty to have strong random ones generated and printed
-- in the Messages tab at the end (copy them into backend\.env).
DECLARE @SchedulerDb  sysname       = N'SCHEDULER';
DECLARE @CompanyDb    sysname       = N'HFARMCompany1';          -- your SYSPRO company DB
DECLARE @SchedulerPwd nvarchar(128) = N'';
DECLARE @SysproPwd    nvarchar(128) = N'';
-- ▲▲▲ ---------------------------------------------------------- ▲▲▲

SET NOCOUNT ON;

DECLARE @bin varbinary(24), @generated bit = 0;
IF ISNULL(@SchedulerPwd, N'') = N'' OR @SchedulerPwd LIKE N'CHANGE_ME%'
BEGIN
  SET @bin = CRYPT_GEN_RANDOM(24);
  -- 'Aps!7' guarantees upper/lower/digit/symbol for CHECK_POLICY; the rest is 32 random chars.
  SET @SchedulerPwd = N'Aps!7' + REPLACE(REPLACE(
    CAST(N'' AS xml).value('xs:base64Binary(sql:variable("@bin"))', 'nvarchar(64)'), N'+', N'x'), N'/', N'y');
  SET @generated = 1;
END
IF ISNULL(@SysproPwd, N'') = N'' OR @SysproPwd LIKE N'CHANGE_ME%'
BEGIN
  SET @bin = CRYPT_GEN_RANDOM(24);
  SET @SysproPwd = N'Aps!7' + REPLACE(REPLACE(
    CAST(N'' AS xml).value('xs:base64Binary(sql:variable("@bin"))', 'nvarchar(64)'), N'+', N'x'), N'/', N'y');
  SET @generated = 1;
END
IF DB_ID(@SchedulerDb) IS NULL OR DB_ID(@CompanyDb) IS NULL
BEGIN
  RAISERROR(N'@SchedulerDb or @CompanyDb does not exist on this instance.', 16, 1);
  RETURN;
END

DECLARE @sql nvarchar(max);

-- 1. Logins ---------------------------------------------------------------
IF SUSER_ID(N'aps_scheduler') IS NULL
BEGIN
  SET @sql = N'CREATE LOGIN [aps_scheduler] WITH PASSWORD = ' + QUOTENAME(@SchedulerPwd, '''') +
             N', CHECK_POLICY = ON, DEFAULT_DATABASE = ' + QUOTENAME(@SchedulerDb) + N';';
  EXEC (@sql);
  PRINT 'Created login aps_scheduler';
END
ELSE PRINT 'Login aps_scheduler already exists (password not changed)';

IF SUSER_ID(N'aps_syspro') IS NULL
BEGIN
  SET @sql = N'CREATE LOGIN [aps_syspro] WITH PASSWORD = ' + QUOTENAME(@SysproPwd, '''') +
             N', CHECK_POLICY = ON, DEFAULT_DATABASE = ' + QUOTENAME(@CompanyDb) + N';';
  EXEC (@sql);
  PRINT 'Created login aps_syspro';
END
ELSE PRINT 'Login aps_syspro already exists (password not changed)';

-- 2. SCHEDULER DB ---------------------------------------------------------
SET @sql = N'USE ' + QUOTENAME(@SchedulerDb) + N';
IF USER_ID(N''aps_scheduler'') IS NULL CREATE USER [aps_scheduler] FOR LOGIN [aps_scheduler];
ALTER ROLE db_datareader ADD MEMBER [aps_scheduler];
ALTER ROLE db_datawriter ADD MEMBER [aps_scheduler];
ALTER ROLE db_ddladmin   ADD MEMBER [aps_scheduler];   -- app runs its own migrations
PRINT ''SCHEDULER DB permissions granted to aps_scheduler'';';
EXEC (@sql);

-- 3. SYSPRO company DB ----------------------------------------------------
SET @sql = N'USE ' + QUOTENAME(@CompanyDb) + N';
IF USER_ID(N''aps_syspro'') IS NULL CREATE USER [aps_syspro] FOR LOGIN [aps_syspro];
ALTER ROLE db_datareader ADD MEMBER [aps_syspro];

-- Scheduler-owned objects live in schema [aps] (created here if missing, owned by dbo
-- so the aps procs keep ownership chaining to the dbo SYSPRO tables).
IF SCHEMA_ID(N''aps'') IS NULL EXEC (N''CREATE SCHEMA aps AUTHORIZATION dbo'');
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::aps TO [aps_syspro];
GRANT ALTER ON SCHEMA::aps TO [aps_syspro];   -- lets the app create aps.SavedSchedules / aps.Scenarios
GRANT CREATE TABLE TO [aps_syspro];
GRANT VIEW DATABASE STATE TO [aps_syspro];     -- optional: row counts in the Schema diagram

-- Export write-back: only these columns, nothing else in SYSPRO.
GRANT UPDATE ON dbo.WipMaster (SchStartDate, SchStartTime, SchEndDate, SchEndTime,
                               ScheduleFlag, DateCalcMethod) TO [aps_syspro];
GRANT UPDATE ON dbo.WipJobAllLab (ScheduledMachine, IMachine,
                                  SchStartDate, SchStartTime, SchEndDate, SchEndTime,
                                  SchStartRunDate, SchStartRunTime,
                                  PlannedStartDate, PlannedEndDate) TO [aps_syspro];
PRINT ''SYSPRO company DB permissions granted to aps_syspro'';';
EXEC (@sql);

PRINT '';
PRINT 'Done. Put these 4 lines in backend\.env (replacing the existing ones), restart the scheduler, then change the sa password:';
PRINT '';
IF SUSER_ID(N'aps_syspro') IS NOT NULL
BEGIN
  PRINT 'SYSPRO_DB_USER=aps_syspro';
  PRINT 'SYSPRO_DB_PASSWORD=' + @SysproPwd;
  PRINT 'SCHEDULER_DB_USER=aps_scheduler';
  PRINT 'SCHEDULER_DB_PASSWORD=' + @SchedulerPwd;
END
IF @generated = 1
  PRINT '(Passwords above were generated by this run. If a login already existed, its password was NOT changed.)';
