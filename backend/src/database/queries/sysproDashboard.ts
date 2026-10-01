/**
 * Syspro database query definitions for SysproEdu1 database
 * Mapped from SY_* tables to actual SysproEdu1 schema (Mrp*, Wip*, Bom*, etc.)
 */

export const SYSPRO_QUERIES = {
  // ==================== WORK ORDERS ====================
  getOpenJobs: `
    DECLARE @tail NVARCHAR(MAX) = N'
      WHERE ISNULL(wm.Complete, ''N'') <> ''Y''
      ORDER BY ISNULL(TRY_CONVERT(int, wm.Priority), 5) ASC, ISNULL(wm.JobDeliveryDate, wm.SchEndDate) ASC';
    -- Master/sub link source resolves at runtime: WipMasterSub (standard),
    -- WipSubJob (variant installs), or the WipMaster.MasterJob column.
    -- If both link tables exist, prefer the one that actually has rows.
    DECLARE @linkTable sysname = NULL;
    IF OBJECT_ID('WipMasterSub', 'U') IS NOT NULL SET @linkTable = 'WipMasterSub';
    IF OBJECT_ID('WipSubJob', 'U') IS NOT NULL AND @linkTable IS NULL SET @linkTable = 'WipSubJob';
    IF OBJECT_ID('WipMasterSub', 'U') IS NOT NULL AND OBJECT_ID('WipSubJob', 'U') IS NOT NULL
    BEGIN
      DECLARE @cMs int = 0, @cSj int = 0;
      EXEC sp_executesql N'SELECT @c = COUNT(*) FROM WipMasterSub', N'@c int OUTPUT', @c = @cMs OUTPUT;
      EXEC sp_executesql N'SELECT @c = COUNT(*) FROM WipSubJob', N'@c int OUTPUT', @c = @cSj OUTPUT;
      SET @linkTable = CASE WHEN @cMs = 0 AND @cSj > 0 THEN 'WipSubJob' ELSE 'WipMasterSub' END;
    END

    DECLARE @parentCol sysname = NULL, @childCol sysname = NULL;
    IF @linkTable IS NOT NULL
    BEGIN
      SET @childCol = CASE
        WHEN COL_LENGTH(@linkTable, 'SubJob') IS NOT NULL THEN 'SubJob'
        WHEN COL_LENGTH(@linkTable, 'Job') IS NOT NULL AND COL_LENGTH(@linkTable, 'MasterJob') IS NOT NULL THEN 'Job'
        ELSE NULL END;
      SET @parentCol = CASE
        WHEN COL_LENGTH(@linkTable, 'MasterJob') IS NOT NULL THEN 'MasterJob'
        WHEN COL_LENGTH(@linkTable, 'Job') IS NOT NULL THEN 'Job'
        ELSE NULL END;
      IF @parentCol IS NULL OR @childCol IS NULL OR @parentCol = @childCol SET @linkTable = NULL;
    END

    DECLARE @base NVARCHAR(MAX) = N'
      SELECT
        wm.*,
        wm.Job as jobId,
        wm.StockCode as itemCode,
        ISNULL(NULLIF(wm.JobDescription, ''''), wm.StockDescription) as description,
        ISNULL(wm.QtyToMake, 0) as quantity,
        ISNULL(wm.JobDeliveryDate, ISNULL(wm.SchEndDate, GETDATE())) as dueDate,
        ISNULL(wm.JobStartDate, ISNULL(wm.SchStartDate, GETDATE())) as releaseDate,
        TRY_CONVERT(int, wm.Priority) as priority,
        CASE
          WHEN wm.Complete = ''Y'' THEN ''Complete''
          WHEN wm.HoldFlag = ''Y'' THEN ''OnHold''
          WHEN wm.ConfirmedFlag = ''Y'' THEN ''Released''
          ELSE ''Firm''
        END as status,
        ISNULL(wm.ExpMaterial, 0) as estimatedMaterialCost, ';

    DECLARE @sql NVARCHAR(MAX);
    IF @linkTable IS NOT NULL
      SET @sql = @base + N'
        NULLIF(RTRIM(parent.' + @parentCol + N'), '''') as masterJobId,
        NULLIF(RTRIM(parent.' + @parentCol + N'), '''') as MasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM ' + @linkTable + N' rel WHERE rel.' + @parentCol + N' = wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsMasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM ' + @linkTable + N' rel WHERE rel.' + @childCol + N' = wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsSubJob
      FROM WipMaster wm
      LEFT JOIN ' + @linkTable + N' parent ON parent.' + @childCol + N' = wm.Job' + @tail;
    ELSE IF COL_LENGTH('WipMaster', 'MasterJob') IS NOT NULL
      SET @sql = @base + N'
        NULLIF(RTRIM(wm.MasterJob), '''') as masterJobId,
        NULLIF(RTRIM(wm.MasterJob), '''') as MasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM WipMaster c WHERE c.MasterJob = wm.Job AND c.Job <> wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsMasterJob,
        CASE WHEN NULLIF(RTRIM(wm.MasterJob), '''') IS NOT NULL THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsSubJob
      FROM WipMaster wm' + @tail;
    ELSE
      SET @sql = @base + N'
        CAST(NULL AS varchar(30)) as masterJobId,
        CAST(NULL AS varchar(30)) as MasterJob,
        CAST(0 AS bit) as IsMasterJob,
        CAST(0 AS bit) as IsSubJob
      FROM WipMaster wm' + @tail;
    EXEC sp_executesql @sql;
  `,

  getJobById: `
    DECLARE @tail NVARCHAR(MAX) = N'
      WHERE wm.Job = @jobId';
    -- Master/sub link source resolves at runtime: WipMasterSub (standard),
    -- WipSubJob (variant installs), or the WipMaster.MasterJob column.
    -- If both link tables exist, prefer the one that actually has rows.
    DECLARE @linkTable sysname = NULL;
    IF OBJECT_ID('WipMasterSub', 'U') IS NOT NULL SET @linkTable = 'WipMasterSub';
    IF OBJECT_ID('WipSubJob', 'U') IS NOT NULL AND @linkTable IS NULL SET @linkTable = 'WipSubJob';
    IF OBJECT_ID('WipMasterSub', 'U') IS NOT NULL AND OBJECT_ID('WipSubJob', 'U') IS NOT NULL
    BEGIN
      DECLARE @cMs int = 0, @cSj int = 0;
      EXEC sp_executesql N'SELECT @c = COUNT(*) FROM WipMasterSub', N'@c int OUTPUT', @c = @cMs OUTPUT;
      EXEC sp_executesql N'SELECT @c = COUNT(*) FROM WipSubJob', N'@c int OUTPUT', @c = @cSj OUTPUT;
      SET @linkTable = CASE WHEN @cMs = 0 AND @cSj > 0 THEN 'WipSubJob' ELSE 'WipMasterSub' END;
    END

    DECLARE @parentCol sysname = NULL, @childCol sysname = NULL;
    IF @linkTable IS NOT NULL
    BEGIN
      SET @childCol = CASE
        WHEN COL_LENGTH(@linkTable, 'SubJob') IS NOT NULL THEN 'SubJob'
        WHEN COL_LENGTH(@linkTable, 'Job') IS NOT NULL AND COL_LENGTH(@linkTable, 'MasterJob') IS NOT NULL THEN 'Job'
        ELSE NULL END;
      SET @parentCol = CASE
        WHEN COL_LENGTH(@linkTable, 'MasterJob') IS NOT NULL THEN 'MasterJob'
        WHEN COL_LENGTH(@linkTable, 'Job') IS NOT NULL THEN 'Job'
        ELSE NULL END;
      IF @parentCol IS NULL OR @childCol IS NULL OR @parentCol = @childCol SET @linkTable = NULL;
    END

    DECLARE @base NVARCHAR(MAX) = N'
      SELECT
        wm.*,
        wm.Job as jobId,
        wm.StockCode as itemCode,
        ISNULL(NULLIF(wm.JobDescription, ''''), wm.StockDescription) as description,
        ISNULL(wm.QtyToMake, 0) as quantity,
        ISNULL(wm.JobDeliveryDate, ISNULL(wm.SchEndDate, GETDATE())) as dueDate,
        ISNULL(wm.JobStartDate, ISNULL(wm.SchStartDate, GETDATE())) as releaseDate,
        TRY_CONVERT(int, wm.Priority) as priority,
        CASE
          WHEN wm.Complete = ''Y'' THEN ''Complete''
          WHEN wm.HoldFlag = ''Y'' THEN ''OnHold''
          WHEN wm.ConfirmedFlag = ''Y'' THEN ''Released''
          ELSE ''Firm''
        END as status,
        ISNULL(wm.ExpMaterial, 0) as estimatedMaterialCost, ';

    DECLARE @sql NVARCHAR(MAX);
    IF @linkTable IS NOT NULL
      SET @sql = @base + N'
        NULLIF(RTRIM(parent.' + @parentCol + N'), '''') as masterJobId,
        NULLIF(RTRIM(parent.' + @parentCol + N'), '''') as MasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM ' + @linkTable + N' rel WHERE rel.' + @parentCol + N' = wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsMasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM ' + @linkTable + N' rel WHERE rel.' + @childCol + N' = wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsSubJob
      FROM WipMaster wm
      LEFT JOIN ' + @linkTable + N' parent ON parent.' + @childCol + N' = wm.Job' + @tail;
    ELSE IF COL_LENGTH('WipMaster', 'MasterJob') IS NOT NULL
      SET @sql = @base + N'
        NULLIF(RTRIM(wm.MasterJob), '''') as masterJobId,
        NULLIF(RTRIM(wm.MasterJob), '''') as MasterJob,
        CASE WHEN EXISTS (SELECT 1 FROM WipMaster c WHERE c.MasterJob = wm.Job AND c.Job <> wm.Job) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsMasterJob,
        CASE WHEN NULLIF(RTRIM(wm.MasterJob), '''') IS NOT NULL THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsSubJob
      FROM WipMaster wm' + @tail;
    ELSE
      SET @sql = @base + N'
        CAST(NULL AS varchar(30)) as masterJobId,
        CAST(NULL AS varchar(30)) as MasterJob,
        CAST(0 AS bit) as IsMasterJob,
        CAST(0 AS bit) as IsSubJob
      FROM WipMaster wm' + @tail;
    EXEC sp_executesql @sql, N'@jobId nvarchar(30)', @jobId = @jobId;
  `,

  // ==================== OPERATIONS / ROUTING ====================
  getOperationsByJob: `
    IF COL_LENGTH('WipJobAllLab', 'WorkCentreDesc') IS NOT NULL
    BEGIN
      SELECT 
        CONCAT(l.Job, '-OP', CAST(CAST(l.Operation as int) as varchar(20))) as opId,
        l.Job as jobId,
        CAST(l.Operation as int) as sequence,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) as workcentreId,
        ISNULL(NULLIF(l.WorkCentreDesc, ''), ISNULL(l.WorkCentre, 'Unknown')) as workcentreName,
        (ISNULL(l.IExpUnitRunTim, 0) * ISNULL(NULLIF(l.ParentQtyPlanned, 0), ISNULL((SELECT wm.QtyToMake FROM WipMaster wm WHERE wm.Job = l.Job), 1))) as duration,
        ISNULL(l.IExpSetUpTime, 0) as setupTime,
        ISNULL(l.QueueTime, 0) as queueTime,
        ISNULL(l.MovementTime, 0) as moveTime,
        ISNULL(NULLIF(l.IQuantity, 0), 1) as batchSize,
        ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'NotStarted') as status,
        l.ScheduledMachine,
        l.IMachine,
        l.*
      FROM WipJobAllLab l
      WHERE l.Job = @jobId
      ORDER BY CAST(l.Operation as int) ASC
    END
    ELSE
    BEGIN
      SELECT 
        CONCAT(l.Job, '-OP', CAST(CAST(l.Operation as int) as varchar(20))) as opId,
        l.Job as jobId,
        CAST(l.Operation as int) as sequence,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) as workcentreId,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'Unknown')) as workcentreName,
        (ISNULL(l.IExpUnitRunTim, 0) * ISNULL(NULLIF(l.ParentQtyPlanned, 0), ISNULL((SELECT wm.QtyToMake FROM WipMaster wm WHERE wm.Job = l.Job), 1))) as duration,
        ISNULL(l.IExpSetUpTime, 0) as setupTime,
        ISNULL(l.QueueTime, 0) as queueTime,
        ISNULL(l.MovementTime, 0) as moveTime,
        ISNULL(NULLIF(l.IQuantity, 0), 1) as batchSize,
        ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'NotStarted') as status,
        l.ScheduledMachine,
        l.IMachine,
        l.*
      FROM WipJobAllLab l
      WHERE l.Job = @jobId
      ORDER BY CAST(l.Operation as int) ASC
    END
  `,
  /** Every operation of every open job in one round trip (replaces the per-job
   *  getOperationsByJob loop — one query instead of N+1). Same columns. */
  getOperationsForOpenJobs: `
    IF COL_LENGTH('WipJobAllLab', 'WorkCentreDesc') IS NOT NULL
    BEGIN
      SELECT 
        CONCAT(l.Job, '-OP', CAST(CAST(l.Operation as int) as varchar(20))) as opId,
        l.Job as jobId,
        CAST(l.Operation as int) as sequence,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) as workcentreId,
        ISNULL(NULLIF(l.WorkCentreDesc, ''), ISNULL(l.WorkCentre, 'Unknown')) as workcentreName,
        (ISNULL(l.IExpUnitRunTim, 0) * ISNULL(NULLIF(l.ParentQtyPlanned, 0), ISNULL(wm.QtyToMake, 1))) as duration,
        ISNULL(l.IExpSetUpTime, 0) as setupTime,
        ISNULL(l.QueueTime, 0) as queueTime,
        ISNULL(l.MovementTime, 0) as moveTime,
        ISNULL(NULLIF(l.IQuantity, 0), 1) as batchSize,
        ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'NotStarted') as status,
        l.ScheduledMachine,
        l.IMachine,
        l.*
      FROM WipJobAllLab l
      JOIN WipMaster wm ON wm.Job = l.Job
      WHERE ISNULL(wm.Complete, 'N') <> 'Y'
      ORDER BY l.Job ASC, CAST(l.Operation as int) ASC
    END
    ELSE
    BEGIN
      SELECT 
        CONCAT(l.Job, '-OP', CAST(CAST(l.Operation as int) as varchar(20))) as opId,
        l.Job as jobId,
        CAST(l.Operation as int) as sequence,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) as workcentreId,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'Unknown')) as workcentreName,
        (ISNULL(l.IExpUnitRunTim, 0) * ISNULL(NULLIF(l.ParentQtyPlanned, 0), ISNULL(wm.QtyToMake, 1))) as duration,
        ISNULL(l.IExpSetUpTime, 0) as setupTime,
        ISNULL(l.QueueTime, 0) as queueTime,
        ISNULL(l.MovementTime, 0) as moveTime,
        ISNULL(NULLIF(l.IQuantity, 0), 1) as batchSize,
        ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'NotStarted') as status,
        l.ScheduledMachine,
        l.IMachine,
        l.*
      FROM WipJobAllLab l
      JOIN WipMaster wm ON wm.Job = l.Job
      WHERE ISNULL(wm.Complete, 'N') <> 'Y'
      ORDER BY l.Job ASC, CAST(l.Operation as int) ASC
    END
  `,

  getOperationResources: `
    SELECT DISTINCT
      bo.Operation as opId,
      '' as resourceId,
      '' as resourceName,
      '' as resourceType,
      bo.WorkCentre as worcentreId,
      '' as skillTags
    FROM BomOperations bo
    WHERE bo.StockCode = (SELECT StockCode FROM MrpJobMaster WHERE Job = @jobId)
      AND bo.Route = (SELECT Route FROM MrpJobMaster WHERE Job = @jobId)
    ORDER BY bo.Operation ASC
  `,

  // ==================== WORKCENTRES ====================
  getWorkcentres: `
    DECLARE @sql NVARCHAR(MAX);
    DECLARE @descExpr NVARCHAR(200);

    IF OBJECT_ID('BomWorkCentres', 'U') IS NOT NULL
    BEGIN
      SET @descExpr = CASE
        WHEN COL_LENGTH('BomWorkCentres', 'WorkCentreDesc') IS NOT NULL THEN N'ISNULL(NULLIF(wc.WorkCentreDesc, ''''), '''')'
        ELSE N'CAST('''' AS varchar(100))'
      END;

      SET @sql = N'
        SELECT 
          wc.WorkCentre as worcentreId,
          ISNULL(NULLIF(wc.Description, ''''), wc.WorkCentre) as name,
          ' + @descExpr + N' as description,
          CAST('''' AS varchar(100)) as capabilities,
          CAST(0 AS decimal(18,2)) as costPerHour,
          CAST(3.0 AS decimal(18,2)) as maxOvertimePerDay,
          CAST('''' AS varchar(20)) as calendarId,
          wc.*
        FROM BomWorkCentres wc
        ORDER BY wc.WorkCentre ASC';
      EXEC sp_executesql @sql;
    END
    ELSE IF OBJECT_ID('BomWorkCentre', 'U') IS NOT NULL
    BEGIN
      SET @descExpr = CASE
        WHEN COL_LENGTH('BomWorkCentre', 'WorkCentreDesc') IS NOT NULL THEN N'ISNULL(NULLIF(wc.WorkCentreDesc, ''''), '''')'
        ELSE N'CAST('''' AS varchar(100))'
      END;

      SET @sql = N'
        SELECT 
          wc.WorkCentre as worcentreId,
          ISNULL(NULLIF(wc.Description, ''''), wc.WorkCentre) as name,
          ' + @descExpr + N' as description,
          CAST('''' AS varchar(100)) as capabilities,
          CAST(0 AS decimal(18,2)) as costPerHour,
          CAST(3.0 AS decimal(18,2)) as maxOvertimePerDay,
          CAST('''' AS varchar(20)) as calendarId,
          wc.*
        FROM BomWorkCentre wc
        ORDER BY wc.WorkCentre ASC';
      EXEC sp_executesql @sql;
    END
    ELSE
      SELECT TOP 0
        CAST('' AS varchar(30)) as worcentreId,
        CAST('' AS varchar(100)) as name,
        CAST('' AS varchar(100)) as description,
        CAST('' AS varchar(100)) as capabilities,
        CAST(0 AS decimal(18,2)) as costPerHour,
        CAST(3.0 AS decimal(18,2)) as maxOvertimePerDay,
        CAST('' AS varchar(20)) as calendarId;
  `,

  getWorkcentreById: `
    SELECT 
      wc.WorkCentre as worcentreId,
      wc.Description as name,
      '' as description,
      0 as costPerHour,
      3.0 as maxOvertimePerDay,
      '' as calendarId
    FROM BomWorkCentre wc
    WHERE wc.WorkCentre = @worcentreId
  `,

  // ==================== RESOURCES / EMPLOYEES ====================
  getResources: `
    IF OBJECT_ID('BomMachine', 'U') IS NOT NULL
      SELECT 
        m.Machine as resourceId,
        ISNULL(NULLIF(m.Description, ''), m.Machine) as name,
        'Machine' as type,
        m.WorkCentre as worcentreId,
        0 as costPerHour,
        '' as skillTags,
        'Available' as status,
        ISNULL(m.ShiftId, '') as calendarId,
        m.*
      FROM BomMachine m
      ORDER BY m.WorkCentre, m.Machine ASC;
    ELSE IF OBJECT_ID('BomWorkCentres', 'U') IS NOT NULL
      SELECT 
        wc.WorkCentre as resourceId,
        ISNULL(NULLIF(wc.Description, ''), wc.WorkCentre) as name,
        'Machine' as type,
        wc.WorkCentre as worcentreId,
        0 as costPerHour,
        '' as skillTags,
        'Available' as status,
        '' as calendarId,
        wc.*
      FROM BomWorkCentres wc
      ORDER BY wc.WorkCentre ASC;
    ELSE IF OBJECT_ID('BomWorkCentre', 'U') IS NOT NULL
      SELECT 
        wc.WorkCentre as resourceId,
        ISNULL(NULLIF(wc.Description, ''), wc.WorkCentre) as name,
        'Machine' as type,
        wc.WorkCentre as worcentreId,
        0 as costPerHour,
        '' as skillTags,
        'Available' as status,
        '' as calendarId,
        wc.*
      FROM BomWorkCentre wc
      ORDER BY wc.WorkCentre ASC;
    ELSE
      SELECT TOP 0
        CAST('' AS varchar(30)) as resourceId,
        CAST('' AS varchar(100)) as name,
        CAST('Machine' AS varchar(20)) as type,
        CAST('' AS varchar(30)) as worcentreId,
        CAST(0 AS decimal(18,2)) as costPerHour,
        CAST('' AS varchar(100)) as skillTags,
        CAST('Available' AS varchar(20)) as status,
        CAST('' AS varchar(20)) as calendarId;
  `,

  getResourcesByWorkcentre: `SELECT '' as resourceId WHERE 1=0`,

  // ==================== MATERIALS / BOM ====================
  getMaterialsByJob: `
    BEGIN TRY
      IF OBJECT_ID('WipJobAllMat', 'U') IS NOT NULL AND ISNULL(LTRIM(RTRIM(@jobId)), '') <> ''
        SELECT
          CONCAT(m.Job, '-', ROW_NUMBER() OVER (ORDER BY ISNULL(m.StockCode, ''), ISNULL(m.SequenceNum, 0))) as bomId,
          ISNULL(NULLIF(wm.StockCode, ''), @itemCode) as itemCode,
          m.StockCode as componentCode,
          ISNULL(NULLIF(m.NetUnitQtyReqd, 0), ISNULL(m.UnitQtyReqd, 0)) as quantityRequired,
          ISNULL(m.Uom, 'EA') as unitOfMeasure,
          ISNULL(m.ScrapPercentage, 0) / 100.0 as scrapFactor
        FROM WipJobAllMat m
        LEFT JOIN WipMaster wm ON wm.Job = m.Job
        WHERE m.Job = @jobId
          AND ISNULL(NULLIF(m.StockCode, ''), '') <> ''
        ORDER BY m.StockCode ASC;
      ELSE IF OBJECT_ID('BomStructure', 'U') IS NOT NULL
        SELECT
          CONCAT(bs.ParentPart, '-', ROW_NUMBER() OVER (ORDER BY bs.Component)) as bomId,
          bs.ParentPart as itemCode,
          bs.Component as componentCode,
          ISNULL(bs.QtyPer, 0) as quantityRequired,
          CAST('EA' AS varchar(10)) as unitOfMeasure,
          ISNULL(bs.ScrapPercentage, 0) / 100.0 as scrapFactor
        FROM BomStructure bs
        WHERE bs.ParentPart = @itemCode
        ORDER BY bs.Component ASC;
      ELSE IF OBJECT_ID('BomBillOfMaterials', 'U') IS NOT NULL
        SELECT
          CONCAT(b.ParentItemCode, '-', ROW_NUMBER() OVER (ORDER BY b.ComponentItemCode)) as bomId,
          b.ParentItemCode as itemCode,
          b.ComponentItemCode as componentCode,
          ISNULL(b.QuantityRequired, 0) as quantityRequired,
          CAST('EA' AS varchar(10)) as unitOfMeasure,
          ISNULL(b.ScrapFactor, 0) as scrapFactor
        FROM BomBillOfMaterials b
        WHERE b.ParentItemCode = @itemCode
        ORDER BY b.ComponentItemCode ASC;
      ELSE
        SELECT TOP 0
          CAST('' AS varchar(50)) as bomId,
          CAST('' AS varchar(50)) as itemCode,
          CAST('' AS varchar(50)) as componentCode,
          CAST(0 AS decimal(18,4)) as quantityRequired,
          CAST('EA' AS varchar(10)) as unitOfMeasure,
          CAST(0 AS decimal(18,4)) as scrapFactor;
    END TRY
    BEGIN CATCH
      SELECT TOP 0
        CAST('' AS varchar(50)) as bomId,
        CAST('' AS varchar(50)) as itemCode,
        CAST('' AS varchar(50)) as componentCode,
        CAST(0 AS decimal(18,4)) as quantityRequired,
        CAST('EA' AS varchar(10)) as unitOfMeasure,
        CAST(0 AS decimal(18,4)) as scrapFactor;
    END CATCH
  `,

  getInventory: `
    BEGIN TRY
      IF OBJECT_ID('InvMaster', 'U') IS NOT NULL
      BEGIN
        DECLARE @sqlInv NVARCHAR(MAX);
        SET @sqlInv = N'
          SELECT
            im.StockCode as materialId,
            im.StockCode as code,
            ISNULL(NULLIF(im.Description, ''''), im.StockCode) as description,
            ISNULL(im.StockUom, ''EA'') as unitOfMeasure,
            ' + CASE WHEN COL_LENGTH('InvMaster', 'QtyOnHand') IS NOT NULL
              THEN N'ISNULL(im.QtyOnHand, 0)'
              ELSE N'CAST(0 AS decimal(18,4))'
            END + N' as stockQty,
            ' + CASE WHEN COL_LENGTH('InvMaster', 'QtyAllocated') IS NOT NULL
              THEN N'ISNULL(im.QtyAllocated, 0)'
              ELSE N'CAST(0 AS decimal(18,4))'
            END + N' as reservedQty,
            ' + CASE WHEN COL_LENGTH('InvMaster', 'LeadTime') IS NOT NULL
              THEN N'ISNULL(im.LeadTime, 0)'
              ELSE N'CAST(0 AS decimal(18,4))'
            END + N' as leadTimeDays,
            1 as minimumOrderQty
          FROM InvMaster im
          ORDER BY im.StockCode ASC';
        EXEC sp_executesql @sqlInv;
      END
      ELSE
        SELECT TOP 0
          CAST('' AS varchar(50)) as materialId,
          CAST('' AS varchar(50)) as code,
          CAST('' AS varchar(100)) as description,
          CAST('EA' AS varchar(10)) as unitOfMeasure,
          CAST(0 AS decimal(18,4)) as stockQty,
          CAST(0 AS decimal(18,4)) as reservedQty,
          CAST(0 AS decimal(18,4)) as leadTimeDays,
          CAST(1 AS decimal(18,4)) as minimumOrderQty;
    END TRY
    BEGIN CATCH
      SELECT TOP 0
        CAST('' AS varchar(50)) as materialId,
        CAST('' AS varchar(50)) as code,
        CAST('' AS varchar(100)) as description,
        CAST('EA' AS varchar(10)) as unitOfMeasure,
        CAST(0 AS decimal(18,4)) as stockQty,
        CAST(0 AS decimal(18,4)) as reservedQty,
        CAST(0 AS decimal(18,4)) as leadTimeDays,
        CAST(1 AS decimal(18,4)) as minimumOrderQty;
    END CATCH
  `,

  /**
   * Per-warehouse stock breakdown.
   * Returns one row per (stockCode, warehouse) with QtyOnHand, QtyAllocWip
   * (reserved for open jobs) and QtyAllocSO (reserved for sales orders),
   * each guarded by COL_LENGTH so the query degrades gracefully when a
   * SYSPRO version doesn't have a column.
   */
  getInventoryByWarehouse: `
    BEGIN TRY
      IF OBJECT_ID('InvMaster', 'U') IS NOT NULL AND OBJECT_ID('InvWarehouse', 'U') IS NOT NULL
      BEGIN
        DECLARE @sqlInvWh NVARCHAR(MAX);
        SET @sqlInvWh = N'
          SELECT
            im.StockCode AS code,
            ISNULL(NULLIF(im.Description, ''''), im.StockCode) AS description,
            ISNULL(im.StockUom, ''EA'') AS unitOfMeasure,
            ISNULL(NULLIF(iw.Warehouse, ''''), ''(default)'') AS warehouseCode,
            ' + CASE WHEN COL_LENGTH('InvWarehouse', 'QtyOnHand') IS NOT NULL
                THEN N'ISNULL(iw.QtyOnHand, 0)'
                ELSE N'CAST(0 AS decimal(18,4))'
              END + N' AS qtyOnHand,
            ' + CASE WHEN COL_LENGTH('InvWarehouse', 'QtyAllocatedWip') IS NOT NULL
                THEN N'ISNULL(iw.QtyAllocatedWip, 0)'
                WHEN COL_LENGTH('InvWarehouse', 'QtyAllocWip') IS NOT NULL
                THEN N'ISNULL(iw.QtyAllocWip, 0)'
                ELSE N'CAST(0 AS decimal(18,4))'
              END + N' AS qtyAllocWip,
            ' + CASE WHEN COL_LENGTH('InvWarehouse', 'QtyAllocated') IS NOT NULL
                THEN N'ISNULL(iw.QtyAllocated, 0)'
                WHEN COL_LENGTH('InvWarehouse', 'QtyAllocSO') IS NOT NULL
                THEN N'ISNULL(iw.QtyAllocSO, 0)'
                ELSE N'CAST(0 AS decimal(18,4))'
              END + N' AS qtyAllocSO,
            ' + CASE WHEN COL_LENGTH('InvMaster', 'LeadTime') IS NOT NULL
                THEN N'ISNULL(im.LeadTime, 0)'
                ELSE N'CAST(0 AS decimal(18,4))'
              END + N' AS leadTimeDays
          FROM InvMaster im
          LEFT JOIN InvWarehouse iw ON iw.StockCode = im.StockCode
          ORDER BY im.StockCode, iw.Warehouse';
        EXEC sp_executesql @sqlInvWh;
      END
      ELSE
        SELECT TOP 0
          CAST('' AS varchar(50)) AS code,
          CAST('' AS varchar(100)) AS description,
          CAST('EA' AS varchar(10)) AS unitOfMeasure,
          CAST('(default)' AS varchar(50)) AS warehouseCode,
          CAST(0 AS decimal(18,4)) AS qtyOnHand,
          CAST(0 AS decimal(18,4)) AS qtyAllocWip,
          CAST(0 AS decimal(18,4)) AS qtyAllocSO,
          CAST(0 AS decimal(18,4)) AS leadTimeDays;
    END TRY
    BEGIN CATCH
      SELECT TOP 0
        CAST('' AS varchar(50)) AS code,
        CAST('' AS varchar(100)) AS description,
        CAST('EA' AS varchar(10)) AS unitOfMeasure,
        CAST('(default)' AS varchar(50)) AS warehouseCode,
        CAST(0 AS decimal(18,4)) AS qtyOnHand,
        CAST(0 AS decimal(18,4)) AS qtyAllocWip,
        CAST(0 AS decimal(18,4)) AS qtyAllocSO,
        CAST(0 AS decimal(18,4)) AS leadTimeDays;
    END CATCH
  `,

  /**
   * Outstanding material need of EVERY open job, one row per WipJobAllMat line.
   * Source of truth for material availability (see services/materialPlan.ts).
   * Columns confirmed on HFARMCompany1 (phase 3 diagnostic, 2026-09-30).
   * Errors are NOT swallowed: a failed material query must not look like
   * "no materials needed".
   */
  getOpenJobMaterialRequirements: `
    SELECT
      RTRIM(m.Job)                           AS jobId,
      RTRIM(m.StockCode)                     AS componentCode,
      RTRIM(ISNULL(m.Warehouse, ''))         AS warehouseCode,
      RTRIM(ISNULL(NULLIF(m.Uom, ''), 'EA')) AS unitOfMeasure,
      CAST(
        CASE WHEN m.FixedQtyPerFlag = 'Y' THEN ISNULL(m.FixedQtyPer, 0)
             ELSE ISNULL(NULLIF(m.NetUnitQtyReqd, 0), ISNULL(m.UnitQtyReqd, 0)) * ISNULL(wm.QtyToMake, 0)
        END * (1 + ISNULL(m.ScrapPercentage, 0) / 100.0)
      AS decimal(18, 6))                     AS requiredQty,
      ISNULL(m.QtyIssued, 0)                 AS issuedQty,
      CASE WHEN m.AllocCompleted = 'Y' THEN 1 ELSE 0 END AS allocCompleted
    FROM WipJobAllMat m
    JOIN WipMaster wm ON wm.Job = m.Job
    WHERE ISNULL(wm.Complete, 'N') <> 'Y'
      AND ISNULL(m.StockCode, '') <> ''
  `,

  // ==================== MRP SUGGESTED JOBS ====================
  // Same layout as WipMaster / WipJobAllLab / WipJobAllMat; ids get the MRP-
  // prefix (utils/suggestedJobs.ts). Empty when the tables are missing.
  getSuggestedJobs: `
    IF OBJECT_ID('MrpSugJobMaster', 'U') IS NULL
      SELECT TOP 0 CAST('' AS varchar(30)) AS jobId
    ELSE
      SELECT
        sj.*,
        'MRP-' + RTRIM(sj.Job) AS jobId,
        RTRIM(sj.Job) AS suggestedJob,
        sj.StockCode AS itemCode,
        ISNULL(NULLIF(sj.JobDescription, ''), sj.StockDescription) AS description,
        ISNULL(sj.QtyToMake, 0) AS quantity,
        ISNULL(sj.JobDeliveryDate, ISNULL(sj.SchEndDate, GETDATE())) AS dueDate,
        ISNULL(sj.JobStartDate, ISNULL(sj.SchStartDate, GETDATE())) AS releaseDate,
        TRY_CONVERT(int, sj.Priority) AS priority,
        'Planned' AS status,
        ISNULL(sj.ExpMaterial, 0) AS estimatedMaterialCost,
        CAST(NULL AS varchar(30)) AS masterJobId,
        CAST(0 AS bit) AS IsMasterJob,
        CAST(0 AS bit) AS IsSubJob
      FROM MrpSugJobMaster sj
      WHERE ISNULL(sj.Complete, 'N') <> 'Y' AND ISNULL(sj.QtyToMake, 0) > 0
      ORDER BY ISNULL(sj.JobDeliveryDate, sj.SchEndDate) ASC
  `,
  getOperationsForSuggestedJobs: `
    IF OBJECT_ID('MrpSugJobAlLab', 'U') IS NULL OR OBJECT_ID('MrpSugJobMaster', 'U') IS NULL
      SELECT TOP 0 CAST('' AS varchar(30)) AS jobId
    ELSE
      SELECT
        CONCAT('MRP-', RTRIM(l.Job), '-OP', CAST(CAST(l.Operation AS int) AS varchar(20))) AS opId,
        'MRP-' + RTRIM(l.Job) AS jobId,
        CAST(l.Operation AS int) AS sequence,
        ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) AS workcentreId,
        ISNULL(NULLIF(l.WorkCentreDesc, ''), ISNULL(l.WorkCentre, 'Unknown')) AS workcentreName,
        (ISNULL(l.IExpUnitRunTim, 0) * ISNULL(NULLIF(l.ParentQtyPlanned, 0), ISNULL(sj.QtyToMake, 1))) AS duration,
        ISNULL(l.IExpSetUpTime, 0) AS setupTime,
        ISNULL(l.QueueTime, 0) AS queueTime,
        ISNULL(l.MovementTime, 0) AS moveTime,
        ISNULL(NULLIF(l.IQuantity, 0), 1) AS batchSize,
        ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'NotStarted') AS status,
        l.ScheduledMachine,
        l.IMachine,
        l.*
      FROM MrpSugJobAlLab l
      JOIN MrpSugJobMaster sj ON sj.Job = l.Job
      WHERE ISNULL(sj.Complete, 'N') <> 'Y'
      ORDER BY l.Job ASC, CAST(l.Operation AS int) ASC
  `,
  getSuggestedJobMaterialRequirements: `
    IF OBJECT_ID('MrpSugJobAlMat', 'U') IS NULL OR OBJECT_ID('MrpSugJobMaster', 'U') IS NULL
      SELECT TOP 0 CAST('' AS varchar(30)) AS jobId
    ELSE
      SELECT
        'MRP-' + RTRIM(m.Job)                  AS jobId,
        RTRIM(m.StockCode)                     AS componentCode,
        RTRIM(ISNULL(m.Warehouse, ''))         AS warehouseCode,
        RTRIM(ISNULL(NULLIF(m.Uom, ''), 'EA')) AS unitOfMeasure,
        CAST(
          CASE WHEN m.FixedQtyPerFlag = 'Y' THEN ISNULL(m.FixedQtyPer, 0)
               ELSE ISNULL(NULLIF(m.NetUnitQtyReqd, 0), ISNULL(m.UnitQtyReqd, 0)) * ISNULL(sj.QtyToMake, 0)
          END * (1 + ISNULL(m.ScrapPercentage, 0) / 100.0)
        AS decimal(18, 6))                     AS requiredQty,
        ISNULL(m.QtyIssued, 0)                 AS issuedQty,
        CASE WHEN m.AllocCompleted = 'Y' THEN 1 ELSE 0 END AS allocCompleted
      FROM MrpSugJobAlMat m
      JOIN MrpSugJobMaster sj ON sj.Job = m.Job
      WHERE ISNULL(sj.Complete, 'N') <> 'Y'
        AND ISNULL(m.StockCode, '') <> ''
  `,

  /**
   * One row per outstanding PO line — for a planner to see exactly when
   * a stock-out clears. Used to render the "Incoming receipts" panel
   * in the BOM modal. Includes promise date so the UI can highlight
   * receipts that arrive late vs the job's planned start.
   */
  getOpenPoReceipts: `
    BEGIN TRY
      IF OBJECT_ID('PorMasterDetail', 'U') IS NOT NULL
      BEGIN
        DECLARE @sqlPo NVARCHAR(MAX);
        SET @sqlPo = N'
          SELECT
            MStockCode AS componentCode,
            ' + CASE WHEN COL_LENGTH('PorMasterDetail', 'MWarehouse') IS NOT NULL
                THEN N'RTRIM(ISNULL(MWarehouse, ''''))'
                ELSE N'CAST('''' AS varchar(10))'
              END + N' AS warehouseCode,
            ' + CASE WHEN COL_LENGTH('PorMasterDetail', 'MOrderNumber') IS NOT NULL
                THEN N'CAST(MOrderNumber AS varchar(50))'
                ELSE N'CAST('''' AS varchar(50))'
              END + N' AS poNumber,
            ' + CASE WHEN COL_LENGTH('PorMasterDetail', 'MPromiseDate') IS NOT NULL
                THEN N'MPromiseDate'
                ELSE N'CAST(NULL AS datetime)'
              END + N' AS promiseDate,
            ' + CASE WHEN COL_LENGTH('PorMasterDetail', 'MDueDate') IS NOT NULL
                THEN N'MDueDate'
                ELSE N'CAST(NULL AS datetime)'
              END + N' AS dueDate,
            CAST(ISNULL(MOrderQty, 0) - ISNULL(MReceivedQty, 0) AS decimal(18,4)) AS outstandingQty
          FROM PorMasterDetail
          WHERE ISNULL(MComplete, ''N'') <> ''Y''
            AND ISNULL(MOrderQty, 0) > ISNULL(MReceivedQty, 0)
            AND ISNULL(NULLIF(MStockCode, ''''), '''') <> ''''
          ORDER BY MStockCode, ' + CASE WHEN COL_LENGTH('PorMasterDetail', 'MPromiseDate') IS NOT NULL
                                    THEN N'MPromiseDate, '
                                    ELSE N''
                                  END + N'MStockCode';
        EXEC sp_executesql @sqlPo;
      END
      ELSE
        SELECT TOP 0
          CAST('' AS varchar(50)) AS componentCode,
          CAST('' AS varchar(50)) AS poNumber,
          CAST(NULL AS datetime) AS promiseDate,
          CAST(NULL AS datetime) AS dueDate,
          CAST(0 AS decimal(18,4)) AS outstandingQty;
    END TRY
    BEGIN CATCH
      SELECT TOP 0
        CAST('' AS varchar(50)) AS componentCode,
        CAST('' AS varchar(50)) AS poNumber,
        CAST(NULL AS datetime) AS promiseDate,
        CAST(NULL AS datetime) AS dueDate,
        CAST(0 AS decimal(18,4)) AS outstandingQty;
    END CATCH
  `,

  // ==================== CALENDARS ====================
  getWorkingCalendar: `SELECT '' as calendarId WHERE 1=0`,

  getHolidays: `SELECT '' as holidayId WHERE 1=0`,

  getShifts: `SELECT '' as shiftId WHERE 1=0`,

  // ==================== SETUP / SEQUENCE ====================
  getSetupSequences: `SELECT '' as fromItemCode WHERE 1=0`,

  // ==================== EXISTING SCHEDULE ====================
  getExistingSchedule: `SELECT 0 as opId WHERE 1=0`
};
