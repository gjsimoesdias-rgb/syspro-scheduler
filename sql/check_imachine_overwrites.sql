/* =============================================================================
   IMachine overwrite check — READ-ONLY. Changes nothing.

   Before commit c8d9c82 (2026-10-02), Send to SYSPRO wrote the scheduled
   machine into WipJobAllLab.IMachine as well as ScheduledMachine. IMachine is
   the job's routing machine, and the scheduler reads {ScheduledMachine,
   IMachine} as the machines an operation may use — so after a send, those
   operations could only ever run on the machine they were last scheduled on.

   This lists open-job operations where that probably happened: the job was
   written by a scheduler (WipMaster.ScheduleFlag = 'U'), IMachine equals
   ScheduledMachine, and the stock code's routing (BomOperations) names a
   different machine for that operation.

   Run in SSMS against the SYSPRO company DB (F5). Share the grids with Claude
   if anything shows up; a repair (section 4) is only a commented-out draft.
   ============================================================================= */
SET NOCOUNT ON;

-- 1. Which machine column does BomOperations have on this install?
SELECT '1-columns' AS [check], c.name AS BomOperationsColumn
FROM sys.columns c
WHERE c.object_id = OBJECT_ID('BomOperations') AND c.name IN ('IMachine', 'Machine', 'WorkCentre', 'Route', 'Operation');

-- 2. Open-job operations where IMachine was probably overwritten
IF OBJECT_ID('BomOperations', 'U') IS NOT NULL
   AND COALESCE(COL_LENGTH('BomOperations', 'IMachine'), COL_LENGTH('BomOperations', 'Machine')) IS NOT NULL
BEGIN
  DECLARE @machineCol sysname = CASE WHEN COL_LENGTH('BomOperations', 'IMachine') IS NOT NULL THEN N'IMachine' ELSE N'Machine' END;
  DECLARE @sql NVARCHAR(MAX) = N'
    SELECT ''2-suspect'' AS [check],
           l.Job, CAST(l.Operation AS int) AS Operation, wm.StockCode,
           l.WorkCentre,
           LTRIM(RTRIM(l.IMachine))          AS IMachineNow,
           LTRIM(RTRIM(l.ScheduledMachine))  AS ScheduledMachine,
           LTRIM(RTRIM(r.RoutingMachine))    AS RoutingMachine
    FROM WipJobAllLab l
    JOIN WipMaster wm ON wm.Job = l.Job
    CROSS APPLY (
      SELECT TOP 1 bo.' + QUOTENAME(@machineCol) + N' AS RoutingMachine
      FROM BomOperations bo
      WHERE bo.StockCode = wm.StockCode AND bo.Operation = l.Operation
      ORDER BY bo.Route
    ) r
    WHERE ISNULL(wm.Complete, ''N'') <> ''Y''
      AND wm.ScheduleFlag = ''U''
      AND ISNULL(LTRIM(RTRIM(l.IMachine)), '''') <> ''''
      AND LTRIM(RTRIM(l.IMachine)) = LTRIM(RTRIM(l.ScheduledMachine))
      AND ISNULL(LTRIM(RTRIM(r.RoutingMachine)), '''') <> ''''
      AND LTRIM(RTRIM(r.RoutingMachine)) <> LTRIM(RTRIM(l.IMachine))
    ORDER BY l.Job, l.Operation;';
  EXEC sp_executesql @sql;
END
ELSE
  SELECT '2-suspect' AS [check], 'BomOperations has no machine column on this install - compare with the routing in SYSPRO by hand (section 3)' AS note;

-- 3. Summary: open, scheduler-written jobs whose ops all have IMachine = ScheduledMachine
SELECT '3-summary' AS [check],
       COUNT(DISTINCT wm.Job) AS JobsWrittenByScheduler,
       SUM(CASE WHEN LTRIM(RTRIM(l.IMachine)) = LTRIM(RTRIM(l.ScheduledMachine)) AND ISNULL(l.IMachine, '') <> '' THEN 1 ELSE 0 END) AS OpsWithIMachineEqualScheduled,
       COUNT(*) AS OpsOnThoseJobs
FROM WipMaster wm
JOIN WipJobAllLab l ON l.Job = wm.Job
WHERE ISNULL(wm.Complete, 'N') <> 'Y' AND wm.ScheduleFlag = 'U';

/* 4. REPAIR — DRAFT, COMMENTED OUT. Do not run without reviewing section 2
   with whoever owns the SYSPRO routings, and a backup. Restores IMachine
   from the routing for the rows section 2 lists.

BEGIN TRAN;
UPDATE l
SET    l.IMachine = r.RoutingMachine
FROM   WipJobAllLab l
JOIN   WipMaster wm ON wm.Job = l.Job
CROSS APPLY (SELECT TOP 1 bo.IMachine AS RoutingMachine          -- or bo.Machine (see section 1)
             FROM BomOperations bo
             WHERE bo.StockCode = wm.StockCode AND bo.Operation = l.Operation
             ORDER BY bo.Route) r
WHERE  ISNULL(wm.Complete, 'N') <> 'Y'
  AND  wm.ScheduleFlag = 'U'
  AND  LTRIM(RTRIM(l.IMachine)) = LTRIM(RTRIM(l.ScheduledMachine))
  AND  ISNULL(LTRIM(RTRIM(r.RoutingMachine)), '') <> ''
  AND  LTRIM(RTRIM(r.RoutingMachine)) <> LTRIM(RTRIM(l.IMachine));
SELECT @@ROWCOUNT AS RowsRestored;
-- check, then: COMMIT;   or   ROLLBACK;
*/
