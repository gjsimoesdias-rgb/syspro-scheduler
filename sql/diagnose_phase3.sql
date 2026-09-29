/* =============================================================================
   Phase 3 diagnostic — READ-ONLY. Changes nothing.
   Run in SSMS against your SYSPRO company DB (F5), then copy ALL result grids
   (Ctrl+A in each grid, Ctrl+Shift+C "copy with headers") back to Claude.
   ============================================================================= */
SET NOCOUNT ON;

-- 1. Stock / allocation columns the material check relies on
SELECT '1-columns' AS [check], t.name AS TableName, c.name AS ColumnName, ty.name AS DataType
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE (t.name = 'InvWarehouse' AND (c.name LIKE 'QtyAlloc%' OR c.name IN ('QtyOnHand','QtyOnOrder')))
   OR (t.name = 'WipJobAllMat' AND c.name IN ('UnitQtyReqd','NetUnitQtyReqd','QtyIssued','Warehouse','FixedQtyPerFlag','AllocCompleted','OperationOffset'))
   OR (t.name = 'WipMaster'    AND c.name IN ('Status','HoldFlag','ConfirmedFlag','Complete','QtyManufactured','TimeStamp','Warehouse'))
   OR (t.name = 'WipJobAllLab' AND (c.name IN ('TimeStamp','OperationStatus','ScheduledMachine','OperCompleted','IExpUnitRunTim','ElapsedTime','Milestone')
                                    OR c.name LIKE '%Subcon%' OR c.name LIKE '%Supplier%' OR c.name LIKE '%Elapsed%' OR c.name LIKE 'Pur%'))
   OR (t.name = 'BomOperations' AND (c.name LIKE '%Subcon%' OR c.name LIKE '%Supplier%' OR c.name LIKE '%Elapsed%'))
   OR (t.name = 'BomWorkCentre' AND (c.name LIKE '%Calendar%' OR c.name LIKE '%Shift%' OR c.name LIKE '%Hours%' OR c.name LIKE '%Subcon%'))
ORDER BY t.name, c.name;

-- 2. Which optional tables exist (and how many rows)
SELECT '2-tables' AS [check], v.name AS TableName,
       CASE WHEN OBJECT_ID(v.name, 'U') IS NULL THEN 'missing' ELSE 'present' END AS State,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(v.name, 'U') AND p.index_id IN (0,1)) AS [Rows]
FROM (VALUES ('WipJobAllocation'),('WipJobAllMat'),('WipMasterSub'),('WipSubJob'),
             ('BomMachine'),('BomWorkCentre'),('BomWorkCentres'),('BomOperations'),
             ('InvWarehouse'),('PorMasterDetail'),('MrpSugJobMaster'),('SorDetail'),
             ('aps.SavedSchedules')) v(name);

-- 3. Any calendar / holiday / shift tables on this install
SELECT '3-calendar-tables' AS [check], s.name AS SchemaName, t.name AS TableName,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS [Rows]
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.name LIKE '%Calend%' OR t.name LIKE '%Holiday%' OR t.name LIKE '%Shift%' OR t.name LIKE '%NonWork%'
ORDER BY t.name;

-- 4. Operation status values and how many ops look like subcontract
SELECT TOP 20 '4-op-status' AS [check], ISNULL(NULLIF(LTRIM(RTRIM(OperationStatus)),''),'(blank)') AS OperationStatus, COUNT(*) AS Ops
FROM WipJobAllLab GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(OperationStatus)),''),'(blank)') ORDER BY Ops DESC;

-- 5. Sample of material lines for 3 open jobs (to sanity-check required vs issued)
SELECT TOP 15 '5-material-sample' AS [check], m.*
FROM WipJobAllMat m
WHERE m.Job IN (SELECT TOP 3 Job FROM WipMaster WHERE ISNULL(Complete,'N') <> 'Y' ORDER BY Job);
