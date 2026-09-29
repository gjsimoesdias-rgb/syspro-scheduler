/*
  Run this script against the Syspro source database.
  It creates scheduler-owned compatibility objects that mirror the LYNQ
  production order and production operation view contracts.
*/

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'aps')
BEGIN
  EXEC('CREATE SCHEMA aps');
END
GO

IF OBJECT_ID('aps.SourceProductionOrders', 'U') IS NULL
BEGIN
  CREATE TABLE aps.SourceProductionOrders (
    IDStr nvarchar(80) NOT NULL,
    TypeID varchar(40) NULL,
    OrdType varchar(40) NULL,
    OrdNumber nvarchar(80) NULL,
    OrdPriority nvarchar(40) NULL,
    SchedulingMethod char(1) NULL,
    MfgType varchar(80) NULL,
    StatusCode1 varchar(40) NULL,
    StatusCode1Description varchar(120) NULL,
    StatusCode2 char(1) NULL,
    StatusCode2Description nvarchar(120) NULL,
    ProdCatCode varchar(80) NULL,
    MatCostType varchar(80) NULL,
    PlannerCode varchar(80) NULL,
    ParentIDStr varchar(80) NULL,
    ParentTypeID varchar(40) NULL,
    ParentOrdType varchar(40) NULL,
    ParentOrdNumber varchar(80) NULL,
    OrdValue decimal(18, 6) NULL,
    ProjectCode nvarchar(80) NULL,
    ProjectDescription nvarchar(255) NULL,
    ProjectValue decimal(18, 6) NULL,
    SourceCustomerCode varchar(80) NULL,
    SourceCustomerName varchar(255) NULL,
    SourceCustomerOrdType varchar(40) NULL,
    SourceCustomerOrdNumber varchar(80) NULL,
    SourceCustomerOrdLineNumber decimal(18, 6) NULL,
    SourceCustomerOrdLineValue decimal(18, 6) NULL,
    SourceCustomerOrdLineReqDate datetime NULL,
    SourcePackageCode varchar(80) NULL,
    LocationCode varchar(80) NULL,
    ItemNumber varchar(80) NULL,
    ItemDescription varchar(255) NULL,
    ItemGroup nvarchar(80) NULL,
    ItemGroupDescription nvarchar(255) NULL,
    Line varchar(80) NULL,
    QuantityOrdered decimal(18, 6) NULL,
    QuantityReported decimal(18, 6) NULL,
    QuantityRequired decimal(18, 6) NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    ReqDate datetime NULL,
    FldDateTime1 datetime NULL,
    FldDateTime2 datetime NULL,
    FldDateTime3 datetime NULL,
    FldDecimal1 decimal(18, 6) NULL,
    FldDecimal2 decimal(18, 6) NULL,
    FldDecimal3 decimal(18, 6) NULL,
    FldDecimal4 decimal(18, 6) NULL,
    FldDecimal5 decimal(18, 6) NULL,
    FldString1 nvarchar(255) NULL,
    FldString2 nvarchar(255) NULL,
    FldString3 nvarchar(255) NULL,
    FldString4 nvarchar(255) NULL,
    FldString5 varchar(255) NULL,
    CONSTRAINT PK_aps_SourceProductionOrders PRIMARY KEY CLUSTERED (IDStr)
  );
END
GO

IF OBJECT_ID('aps.SourceProductionOperations', 'U') IS NULL
BEGIN
  CREATE TABLE aps.SourceProductionOperations (
    IDStr nvarchar(120) NOT NULL,
    TypeID varchar(40) NULL,
    IDRtgDetailStr nvarchar(120) NULL,
    IDRtgHeaderStr nvarchar(80) NULL,
    OrdType varchar(40) NULL,
    OrdNumber nvarchar(80) NULL,
    OrdIDStr nvarchar(80) NULL,
    OperNumber int NULL,
    PathNumber int NULL,
    ParPathNumber int NULL,
    OperSequenceNumber int NULL,
    RecType varchar(40) NULL,
    OperType varchar(40) NULL,
    OperCode nvarchar(120) NULL,
    OperDescription nvarchar(255) NULL,
    WcDeptCode varchar(80) NULL,
    WcCode nvarchar(80) NULL,
    OrdZoneType varchar(40) NULL,
    ToolConsMthd varchar(80) NULL,
    SetupQuantityOrdered int NULL,
    SetupQuantityReported int NULL,
    SetupBatchSize int NULL,
    SetupCyclesPerBatch int NULL,
    SetupPeopleHrsPerCycle decimal(18, 6) NULL,
    SetupPeoplePerCycle decimal(18, 6) NULL,
    SetupMachineHrsPerCycle decimal(18, 6) NULL,
    SetupMachinesPerCycle decimal(18, 6) NULL,
    SetupLabourTimeFixed decimal(18, 6) NULL,
    SetupMachineTimeFixed decimal(18, 6) NULL,
    QuantityOrdered decimal(18, 6) NULL,
    QuantityReported decimal(18, 6) NULL,
    BatchSize decimal(18, 6) NULL,
    CyclesPerBatch int NULL,
    PeopleHrsPerCycle decimal(18, 6) NULL,
    PeoplePerCycle decimal(18, 6) NULL,
    MachineHrsPerCycle decimal(18, 6) NULL,
    MachinesPerCycle decimal(18, 6) NULL,
    RunLabourTimeFixed decimal(18, 6) NULL,
    RunMachineTimeFixed decimal(18, 6) NULL,
    OverlapFg varchar(40) NULL,
    OverlapPt decimal(18, 6) NULL,
    MoveTime decimal(18, 6) NULL,
    QueueTime decimal(18, 6) NULL,
    WcStopTime decimal(18, 6) NULL,
    ProcessingTime decimal(18, 6) NULL,
    StatusCode1 char(1) NULL,
    StatusCode1Description nvarchar(120) NULL,
    StatusCode2 char(1) NULL,
    StatusCode2Description nvarchar(120) NULL,
    CompletenessFlag nvarchar(120) NULL,
    OutsideFlag nvarchar(120) NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    FldDateTime1 datetime NULL,
    FldDateTime2 datetime NULL,
    FldDateTime3 datetime NULL,
    FldDecimal1 decimal(18, 6) NULL,
    FldDecimal2 decimal(18, 6) NULL,
    FldDecimal3 decimal(18, 6) NULL,
    FldDecimal4 decimal(18, 6) NULL,
    FldDecimal5 decimal(18, 6) NULL,
    FldString1 nvarchar(255) NULL,
    FldString2 nvarchar(255) NULL,
    FldString3 nvarchar(255) NULL,
    FldString4 nvarchar(255) NULL,
    FldString5 nvarchar(255) NULL,
    ParToPrevious int NULL,
    DataSrcID int NULL,
    DataSrcStmp int NULL,
    CONSTRAINT PK_aps_SourceProductionOperations PRIMARY KEY CLUSTERED (IDStr)
  );
END
GO

CREATE OR ALTER PROCEDURE aps.RefreshLynqCompatProductionCache
AS
BEGIN
  SET NOCOUNT ON;

  TRUNCATE TABLE aps.SourceProductionOperations;
  TRUNCATE TABLE aps.SourceProductionOrders;

  INSERT INTO aps.SourceProductionOrders (
    IDStr, TypeID, OrdType, OrdNumber, OrdPriority, SchedulingMethod, MfgType,
    StatusCode1, StatusCode1Description, StatusCode2, StatusCode2Description,
    ProdCatCode, MatCostType, PlannerCode, ParentIDStr, ParentTypeID,
    ParentOrdType, ParentOrdNumber, OrdValue, ProjectCode, ProjectDescription,
    ProjectValue, SourceCustomerCode, SourceCustomerName, SourceCustomerOrdType,
    SourceCustomerOrdNumber, SourceCustomerOrdLineNumber, SourceCustomerOrdLineValue,
    SourceCustomerOrdLineReqDate, SourcePackageCode, LocationCode, ItemNumber,
    ItemDescription, ItemGroup, ItemGroupDescription, Line, QuantityOrdered,
    QuantityReported, QuantityRequired, StartDate, EndDate, ReqDate,
    FldDateTime1, FldDateTime2, FldDateTime3, FldDecimal1, FldDecimal2,
    FldDecimal3, FldDecimal4, FldDecimal5, FldString1, FldString2,
    FldString3, FldString4, FldString5
  )
  SELECT
    CAST(wm.Job AS nvarchar(80)) AS IDStr,
    'ProductionOrder' AS TypeID,
    'JOB' AS OrdType,
    CAST(wm.Job AS nvarchar(80)) AS OrdNumber,
    CAST(ISNULL(wm.Priority, 0) AS nvarchar(40)) AS OrdPriority,
    LEFT(ISNULL(wm.ScheduleFlag, ''), 1) AS SchedulingMethod,
    NULL AS MfgType,
    CASE
      WHEN wm.Complete = 'Y' THEN 'Complete'
      WHEN wm.HoldFlag = 'Y' THEN 'OnHold'
      WHEN wm.ConfirmedFlag = 'Y' THEN 'Released'
      ELSE 'Firm'
    END AS StatusCode1,
    CASE
      WHEN wm.Complete = 'Y' THEN 'Complete'
      WHEN wm.HoldFlag = 'Y' THEN 'On Hold'
      WHEN wm.ConfirmedFlag = 'Y' THEN 'Released'
      ELSE 'Firm'
    END AS StatusCode1Description,
    CASE
      WHEN wm.Complete = 'Y' THEN 'C'
      WHEN wm.HoldFlag = 'Y' THEN 'H'
      WHEN wm.ConfirmedFlag = 'Y' THEN 'R'
      ELSE 'F'
    END AS StatusCode2,
    CASE
      WHEN wm.Complete = 'Y' THEN 'Complete'
      WHEN wm.HoldFlag = 'Y' THEN 'On Hold'
      WHEN wm.ConfirmedFlag = 'Y' THEN 'Released'
      ELSE 'Firm'
    END AS StatusCode2Description,
    wm.ProductCode AS ProdCatCode,
    NULL AS MatCostType,
    NULL AS PlannerCode,
    NULLIF(LTRIM(RTRIM(wm.HierarchyJob)), '') AS ParentIDStr,
    CASE WHEN NULLIF(LTRIM(RTRIM(wm.HierarchyJob)), '') IS NULL THEN NULL ELSE 'ProductionOrder' END AS ParentTypeID,
    CASE WHEN NULLIF(LTRIM(RTRIM(wm.HierarchyJob)), '') IS NULL THEN NULL ELSE 'JOB' END AS ParentOrdType,
    NULLIF(LTRIM(RTRIM(wm.HierarchyJob)), '') AS ParentOrdNumber,
    NULL AS OrdValue,
    NULL AS ProjectCode,
    NULL AS ProjectDescription,
    NULL AS ProjectValue,
    NULLIF(LTRIM(RTRIM(wm.Customer)), '') AS SourceCustomerCode,
    NULL AS SourceCustomerName,
    CASE WHEN NULLIF(LTRIM(RTRIM(wm.SalesOrder)), '') IS NULL THEN NULL ELSE 'SO' END AS SourceCustomerOrdType,
    NULLIF(LTRIM(RTRIM(wm.SalesOrder)), '') AS SourceCustomerOrdNumber,
    TRY_CONVERT(decimal(18, 6), wm.SalesOrderLine) AS SourceCustomerOrdLineNumber,
    NULL AS SourceCustomerOrdLineValue,
    wm.JobDeliveryDate AS SourceCustomerOrdLineReqDate,
    NULL AS SourcePackageCode,
    wm.Warehouse AS LocationCode,
    wm.StockCode AS ItemNumber,
    ISNULL(NULLIF(wm.JobDescription, ''), wm.StockDescription) AS ItemDescription,
    NULL AS ItemGroup,
    NULL AS ItemGroupDescription,
    CAST(ISNULL(wm.SalesOrderLine, 0) AS varchar(80)) AS Line,
    TRY_CONVERT(decimal(18, 6), wm.QtyToMake) AS QuantityOrdered,
    TRY_CONVERT(decimal(18, 6), wm.QtyManufactured) AS QuantityReported,
    TRY_CONVERT(decimal(18, 6), wm.QtyToMake) AS QuantityRequired,
    ISNULL(wm.JobStartDate, wm.SchStartDate) AS StartDate,
    ISNULL(wm.SchEndDate, wm.JobDeliveryDate) AS EndDate,
    wm.JobDeliveryDate AS ReqDate,
    wm.JobStartDate AS FldDateTime1,
    wm.SchStartDate AS FldDateTime2,
    wm.SchEndDate AS FldDateTime3,
    TRY_CONVERT(decimal(18, 6), wm.Priority) AS FldDecimal1,
    TRY_CONVERT(decimal(18, 6), wm.QtyToMake) AS FldDecimal2,
    TRY_CONVERT(decimal(18, 6), wm.QtyManufactured) AS FldDecimal3,
    TRY_CONVERT(decimal(18, 6), wm.SalesOrderLine) AS FldDecimal4,
    NULL AS FldDecimal5,
    wm.Warehouse AS FldString1,
    wm.Customer AS FldString2,
    wm.HierarchyJob AS FldString3,
    wm.MrpFromJob AS FldString4,
    wm.ProductCode AS FldString5
  FROM dbo.WipMaster wm
  WHERE ISNULL(wm.Complete, 'N') <> 'Y';

  INSERT INTO aps.SourceProductionOperations (
    IDStr, TypeID, IDRtgDetailStr, IDRtgHeaderStr, OrdType, OrdNumber, OrdIDStr,
    OperNumber, PathNumber, ParPathNumber, OperSequenceNumber, RecType, OperType,
    OperCode, OperDescription, WcDeptCode, WcCode, OrdZoneType, ToolConsMthd,
    SetupQuantityOrdered, SetupQuantityReported, SetupBatchSize, SetupCyclesPerBatch,
    SetupPeopleHrsPerCycle, SetupPeoplePerCycle, SetupMachineHrsPerCycle,
    SetupMachinesPerCycle, SetupLabourTimeFixed, SetupMachineTimeFixed,
    QuantityOrdered, QuantityReported, BatchSize, CyclesPerBatch, PeopleHrsPerCycle,
    PeoplePerCycle, MachineHrsPerCycle, MachinesPerCycle, RunLabourTimeFixed,
    RunMachineTimeFixed, OverlapFg, OverlapPt, MoveTime, QueueTime, WcStopTime,
    ProcessingTime, StatusCode1, StatusCode1Description, StatusCode2,
    StatusCode2Description, CompletenessFlag, OutsideFlag, StartDate, EndDate,
    FldDateTime1, FldDateTime2, FldDateTime3, FldDecimal1, FldDecimal2,
    FldDecimal3, FldDecimal4, FldDecimal5, FldString1, FldString2,
    FldString3, FldString4, FldString5, ParToPrevious, DataSrcID, DataSrcStmp
  )
  SELECT
    CONCAT(l.Job, '-OP', CAST(CAST(l.Operation AS int) AS varchar(20))) AS IDStr,
    'ProductionOperation' AS TypeID,
    CONCAT(l.Job, '-OP', CAST(CAST(l.Operation AS int) AS varchar(20))) AS IDRtgDetailStr,
    CAST(l.Job AS nvarchar(80)) AS IDRtgHeaderStr,
    'JOB' AS OrdType,
    CAST(l.Job AS nvarchar(80)) AS OrdNumber,
    CAST(l.Job AS nvarchar(80)) AS OrdIDStr,
    CAST(l.Operation AS int) AS OperNumber,
    1 AS PathNumber,
    0 AS ParPathNumber,
    CAST(l.Operation AS int) AS OperSequenceNumber,
    'Operation' AS RecType,
    'Machine' AS OperType,
    COALESCE(NULLIF(LTRIM(RTRIM(l.IMachine)), ''), NULLIF(LTRIM(RTRIM(l.WorkCentre)), ''), CONCAT('OP', CAST(CAST(l.Operation AS int) AS varchar(20)))) AS OperCode,
    COALESCE(NULLIF(LTRIM(RTRIM(l.WorkCentreDesc)), ''), NULLIF(LTRIM(RTRIM(l.WorkCentre)), ''), 'Unknown') AS OperDescription,
    NULL AS WcDeptCode,
    l.WorkCentre AS WcCode,
    NULL AS OrdZoneType,
    NULL AS ToolConsMthd,
    TRY_CONVERT(int, l.IQuantity) AS SetupQuantityOrdered,
    TRY_CONVERT(int, l.QtyCompleted) AS SetupQuantityReported,
    TRY_CONVERT(int, NULLIF(l.IQuantity, 0)) AS SetupBatchSize,
    1 AS SetupCyclesPerBatch,
    NULL AS SetupPeopleHrsPerCycle,
    NULL AS SetupPeoplePerCycle,
    TRY_CONVERT(decimal(18, 6), l.IExpSetUpTime) AS SetupMachineHrsPerCycle,
    1 AS SetupMachinesPerCycle,
    NULL AS SetupLabourTimeFixed,
    TRY_CONVERT(decimal(18, 6), l.IExpSetUpTime) AS SetupMachineTimeFixed,
    TRY_CONVERT(decimal(18, 6), l.IQuantity) AS QuantityOrdered,
    TRY_CONVERT(decimal(18, 6), l.QtyCompleted) AS QuantityReported,
    TRY_CONVERT(decimal(18, 6), NULLIF(l.IQuantity, 0)) AS BatchSize,
    1 AS CyclesPerBatch,
    NULL AS PeopleHrsPerCycle,
    NULL AS PeoplePerCycle,
    TRY_CONVERT(decimal(18, 6), l.IExpUnitRunTim) AS MachineHrsPerCycle,
    1 AS MachinesPerCycle,
    NULL AS RunLabourTimeFixed,
    TRY_CONVERT(decimal(18, 6), l.IExpUnitRunTim) AS RunMachineTimeFixed,
    NULL AS OverlapFg,
    NULL AS OverlapPt,
    TRY_CONVERT(decimal(18, 6), l.MovementTime) AS MoveTime,
    TRY_CONVERT(decimal(18, 6), l.QueueTime) AS QueueTime,
    TRY_CONVERT(decimal(18, 6), l.IWaitTime) AS WcStopTime,
    TRY_CONVERT(decimal(18, 6), l.IExpUnitRunTim) AS ProcessingTime,
    LEFT(ISNULL(l.OperationStatus, ''), 1) AS StatusCode1,
    CASE LEFT(ISNULL(l.OperationStatus, ''), 1)
      WHEN 'C' THEN 'Complete'
      WHEN 'I' THEN 'In Progress'
      WHEN 'H' THEN 'On Hold'
      WHEN 'N' THEN 'Not Started'
      ELSE ISNULL(NULLIF(LTRIM(RTRIM(l.OperationStatus)), ''), 'Not Started')
    END AS StatusCode1Description,
    CASE
      WHEN l.InspectionFlag = 'Y' THEN 'I'
      WHEN l.Milestone = 'Y' THEN 'M'
      ELSE NULL
    END AS StatusCode2,
    CASE
      WHEN l.InspectionFlag = 'Y' THEN 'Inspection'
      WHEN l.Milestone = 'Y' THEN 'Milestone'
      ELSE NULL
    END AS StatusCode2Description,
    CASE
      WHEN TRY_CONVERT(decimal(18, 6), l.QtyCompleted) >= TRY_CONVERT(decimal(18, 6), l.IQuantity)
        AND TRY_CONVERT(decimal(18, 6), l.IQuantity) > 0 THEN 'Complete'
      ELSE 'Open'
    END AS CompletenessFlag,
    NULL AS OutsideFlag,
    l.SchStartDate AS StartDate,
    l.SchEndDate AS EndDate,
    l.SchStartDate AS FldDateTime1,
    l.SchEndDate AS FldDateTime2,
    NULL AS FldDateTime3,
    TRY_CONVERT(decimal(18, 6), l.ICapacityReqd) AS FldDecimal1,
    TRY_CONVERT(decimal(18, 6), l.MinorSetUp) AS FldDecimal2,
    TRY_CONVERT(decimal(18, 6), l.ToolSetQty) AS FldDecimal3,
    TRY_CONVERT(decimal(18, 6), l.HoursBilled) AS FldDecimal4,
    TRY_CONVERT(decimal(18, 6), l.QtyScrapped) AS FldDecimal5,
    CAST(l.InspectionFlag AS nvarchar(255)) AS FldString1,
    CAST(l.MinorSetUpCode AS nvarchar(255)) AS FldString2,
    CAST(l.ToolSet AS nvarchar(255)) AS FldString3,
    CAST(l.Milestone AS nvarchar(255)) AS FldString4,
    CAST(l.WorkCentreDesc AS nvarchar(255)) AS FldString5,
    0 AS ParToPrevious,
    1 AS DataSrcID,
    NULL AS DataSrcStmp
  FROM dbo.WipJobAllLab l;
END
GO

CREATE OR ALTER VIEW aps.VP_SourceProductionOrdersView
AS
SELECT
  IDStr,
  TypeID,
  OrdType,
  OrdNumber,
  OrdPriority,
  SchedulingMethod,
  MfgType,
  StatusCode1,
  StatusCode1Description,
  StatusCode2,
  StatusCode2Description,
  ProdCatCode,
  MatCostType,
  PlannerCode,
  ParentIDStr,
  ParentTypeID,
  ParentOrdType,
  ParentOrdNumber,
  OrdValue,
  ProjectCode,
  ProjectDescription,
  ProjectValue,
  SourceCustomerCode,
  SourceCustomerName,
  SourceCustomerOrdType,
  SourceCustomerOrdNumber,
  SourceCustomerOrdLineNumber,
  SourceCustomerOrdLineValue,
  SourceCustomerOrdLineReqDate,
  SourcePackageCode,
  LocationCode,
  ItemNumber,
  ItemDescription,
  ItemGroup,
  ItemGroupDescription,
  Line,
  QuantityOrdered,
  QuantityReported,
  QuantityRequired,
  StartDate,
  EndDate,
  ReqDate,
  FldDateTime1,
  FldDateTime2,
  FldDateTime3,
  FldDecimal1,
  FldDecimal2,
  FldDecimal3,
  FldDecimal4,
  FldDecimal5,
  FldString1,
  FldString2,
  FldString3,
  FldString4,
  FldString5
FROM aps.SourceProductionOrders;
GO

CREATE OR ALTER VIEW aps.VP_SourceProductionOperationsView
AS
SELECT
  IDStr,
  TypeID,
  IDRtgDetailStr,
  IDRtgHeaderStr,
  OrdType,
  OrdNumber,
  OrdIDStr,
  OperNumber,
  PathNumber,
  ParPathNumber,
  OperSequenceNumber,
  RecType,
  OperType,
  OperCode,
  OperDescription,
  WcDeptCode,
  WcCode,
  OrdZoneType,
  ToolConsMthd,
  SetupQuantityOrdered,
  SetupQuantityReported,
  SetupBatchSize,
  SetupCyclesPerBatch,
  SetupPeopleHrsPerCycle,
  SetupPeoplePerCycle,
  SetupMachineHrsPerCycle,
  SetupMachinesPerCycle,
  SetupLabourTimeFixed,
  SetupMachineTimeFixed,
  QuantityOrdered,
  QuantityReported,
  BatchSize,
  CyclesPerBatch,
  PeopleHrsPerCycle,
  PeoplePerCycle,
  MachineHrsPerCycle,
  MachinesPerCycle,
  RunLabourTimeFixed,
  RunMachineTimeFixed,
  OverlapFg,
  OverlapPt,
  MoveTime,
  QueueTime,
  WcStopTime,
  ProcessingTime,
  StatusCode1,
  StatusCode1Description,
  StatusCode2,
  StatusCode2Description,
  CompletenessFlag,
  OutsideFlag,
  StartDate,
  EndDate,
  FldDateTime1,
  FldDateTime2,
  FldDateTime3,
  FldDecimal1,
  FldDecimal2,
  FldDecimal3,
  FldDecimal4,
  FldDecimal5,
  FldString1,
  FldString2,
  FldString3,
  FldString4,
  FldString5,
  ParToPrevious,
  DataSrcID,
  DataSrcStmp
FROM aps.SourceProductionOperations;
GO

IF OBJECT_ID('aps.BPL_Src_WIOrders', 'U') IS NULL
BEGIN
  CREATE TABLE aps.BPL_Src_WIOrders (
    WIOrderID int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    IDStr nvarchar(80) NOT NULL,
    TypeID nvarchar(50) NULL,
    OrdType nvarchar(50) NULL,
    OrdNumber nvarchar(50) NULL,
    ParentIDStr nvarchar(50) NULL,
    ParentTypeID nvarchar(50) NULL,
    StatusCode1 nvarchar(50) NULL,
    StatusCode2 nvarchar(50) NULL,
    LocationCode nvarchar(50) NULL,
    ItemNumber nvarchar(50) NULL,
    ItemDescription nvarchar(200) NULL,
    QuantityOrdered decimal(18, 6) NULL,
    QuantityReported decimal(18, 6) NULL,
    QuantityRequired decimal(18, 6) NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    ReqDate datetime NULL,
    FldString1 nvarchar(100) NULL,
    FldString2 nvarchar(100) NULL,
    CreatedDate datetime NOT NULL CONSTRAINT DF_aps_BPL_Src_WIOrders_CreatedDate DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('aps.BPL_Src_WIOperations', 'U') IS NULL
BEGIN
  CREATE TABLE aps.BPL_Src_WIOperations (
    WIOperationID int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    IDStr nvarchar(120) NOT NULL,
    OrdType nvarchar(50) NULL,
    OrdNumber nvarchar(50) NULL,
    OperNumber int NULL,
    OperSequenceNumber int NULL,
    PathNumber int NULL,
    WcCode nvarchar(50) NULL,
    OperCode nvarchar(100) NULL,
    OperDescription nvarchar(255) NULL,
    QuantityOrdered decimal(18, 6) NULL,
    QuantityReported decimal(18, 6) NULL,
    BatchSize decimal(18, 6) NULL,
    QueueTime decimal(18, 6) NULL,
    MoveTime decimal(18, 6) NULL,
    ProcessingTime decimal(18, 6) NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    CreatedDate datetime NOT NULL CONSTRAINT DF_aps_BPL_Src_WIOperations_CreatedDate DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('aps.BPL_Src_WIMaterials', 'U') IS NULL
BEGIN
  CREATE TABLE aps.BPL_Src_WIMaterials (
    WIMaterialID int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    IDStr nvarchar(120) NOT NULL,
    OrdType nvarchar(50) NULL,
    OrdNumber nvarchar(50) NULL,
    ItemNumber nvarchar(50) NULL,
    ItemDescription nvarchar(255) NULL,
    QuantityRequired decimal(18, 6) NULL,
    CreatedDate datetime NOT NULL CONSTRAINT DF_aps_BPL_Src_WIMaterials_CreatedDate DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('aps.BPL_Src_WorkCentreParams', 'U') IS NULL
BEGIN
  CREATE TABLE aps.BPL_Src_WorkCentreParams (
    WcID int NULL,
    IsAllowedForSchedule bit NOT NULL,
    UpdatedDate datetime NOT NULL CONSTRAINT DF_aps_BPL_Src_WorkCentreParams_UpdatedDate DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('aps.BPL_Src_SchedulingInfoLog', 'U') IS NULL
BEGIN
  CREATE TABLE aps.BPL_Src_SchedulingInfoLog (
    ID int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    TypeID nvarchar(50) NULL,
    OrdType nvarchar(50) NULL,
    OrdNumber nvarchar(50) NULL,
    IsHeader bit NULL,
    OperNumber int NULL,
    PathNumber int NULL,
    ParPathNumber int NULL,
    OperSequenceNumber int NULL,
    RecType nvarchar(50) NULL,
    OperType nvarchar(50) NULL,
    SrcStartDate datetime NULL,
    SrcEndDate datetime NULL,
    SrcWcCode nvarchar(50) NULL,
    SrcWcDeptCode nvarchar(50) NULL,
    IsScheduled bit NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    WcID int NULL,
    WcErpCode nvarchar(50) NULL,
    WcErpDeptCode nvarchar(50) NULL,
    FIXEDTIME_StartDate datetime NULL,
    FIXEDTIME_EndDate datetime NULL,
    FIXEDTIME_FinishedDiscretes decimal(18, 6) NULL,
    FIXEDTIME_InProcessDiscretes decimal(18, 6) NULL,
    PRODUCTION_StartDate datetime NULL,
    PRODUCTION_EndDate datetime NULL,
    PRODUCTION_FinishedDiscretes decimal(18, 6) NULL,
    PRODUCTION_InProcessDiscretes decimal(18, 6) NULL,
    RUN_StartDate datetime NULL,
    RUN_EndDate datetime NULL,
    RUN_FinishedDiscretes decimal(18, 6) NULL,
    RUN_InProcessDiscretes decimal(18, 6) NULL,
    SETUP_StartDate datetime NULL,
    SETUP_EndDate datetime NULL,
    SETUP_FinishedDiscretes decimal(18, 6) NULL,
    SETUP_InProcessDiscretes decimal(18, 6) NULL,
    PROCESSING_StartDate datetime NULL,
    PROCESSING_EndDate datetime NULL,
    PROCESSING_FinishedDiscretes decimal(18, 6) NULL,
    PROCESSING_InProcessDiscretes decimal(18, 6) NULL,
    PROCESSING2_StartDate datetime NULL,
    PROCESSING2_EndDate datetime NULL,
    PROCESSING2_FinishedDiscretes decimal(18, 6) NULL,
    PROCESSING2_InProcessDiscretes decimal(18, 6) NULL,
    SchedChangeByUser nvarchar(100) NULL,
    SchedChangeBySQLUser nvarchar(100) NULL,
    ExtSyncMthd nvarchar(100) NULL,
    ExtSyncParam nvarchar(100) NULL,
    ExtSyncStamp nvarchar(100) NULL,
    ExtSyncState nvarchar(100) NULL,
    ExtSyncMsg nvarchar(1000) NULL,
    CreatedDate datetime NOT NULL CONSTRAINT DF_aps_BPL_Src_SchedulingInfoLog_CreatedDate DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('aps.SchedulerRecordSummary', 'U') IS NULL
BEGIN
  CREATE TABLE aps.SchedulerRecordSummary (
    ID int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    OrdNumber nvarchar(80) NOT NULL,
    OrdSchedType nvarchar(40) NOT NULL,
    OperNumber int NULL,
    OperSequenceNumber int NULL,
    PathNumber int NULL,
    SummaryDate date NOT NULL,
    StartDate datetime NULL,
    EndDate datetime NULL,
    WcCode nvarchar(80) NULL,
    CreatedDate datetime NOT NULL CONSTRAINT DF_aps_SchedulerRecordSummary_CreatedDate DEFAULT GETDATE()
  );
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_BPL_CreateWIBPL
  @IncludeDepended bit,
  @OrdType nvarchar(50),
  @ItemNumber nvarchar(50),
  @LocCode nvarchar(50),
  @RtgNumber nvarchar(50),
  @RtgVersion nvarchar(50),
  @RtgRelease nvarchar(50),
  @QuantityOrdered decimal(18, 6),
  @QuantityReported decimal(18, 6),
  @StartDate datetime,
  @EndDate datetime,
  @Description1 nvarchar(100),
  @Description2 nvarchar(100)
AS
BEGIN
  SET NOCOUNT ON;

  SET @OrdType = ISNULL(@OrdType, 'WI');
  SET @ItemNumber = ISNULL(@ItemNumber, '');

  DECLARE @OrdNumber nvarchar(50) = CONCAT('APS-WI-', LEFT(REPLACE(CONVERT(varchar(36), NEWID()), '-', ''), 12));
  DECLARE @ItemDescription nvarchar(200) = COALESCE(
    NULLIF(@Description1, ''),
    NULLIF(@Description2, ''),
    (SELECT TOP 1 ItemDescription FROM aps.SourceProductionOrders WHERE ItemNumber = @ItemNumber),
    @ItemNumber
  );

  INSERT INTO aps.BPL_Src_WIOrders (
    IDStr, TypeID, OrdType, OrdNumber, ParentIDStr, ParentTypeID, StatusCode1, StatusCode2,
    LocationCode, ItemNumber, ItemDescription, QuantityOrdered, QuantityReported, QuantityRequired,
    StartDate, EndDate, ReqDate, FldString1, FldString2
  )
  VALUES (
    @OrdNumber, 'WIO', @OrdType, @OrdNumber, '', '', 'Y', '',
    @LocCode, @ItemNumber, @ItemDescription, ISNULL(@QuantityOrdered, 0), ISNULL(@QuantityReported, 0),
    ISNULL(@QuantityOrdered, 0) - ISNULL(@QuantityReported, 0), @StartDate, @EndDate, @EndDate,
    @RtgNumber, CONCAT(ISNULL(@RtgVersion, ''), CASE WHEN ISNULL(@RtgRelease, '') = '' THEN '' ELSE CONCAT('|', @RtgRelease) END)
  );

  IF @IncludeDepended = 1
  BEGIN
    INSERT INTO aps.BPL_Src_WIOperations (
      IDStr, OrdType, OrdNumber, OperNumber, OperSequenceNumber, PathNumber, WcCode,
      OperCode, OperDescription, QuantityOrdered, QuantityReported, BatchSize,
      QueueTime, MoveTime, ProcessingTime, StartDate, EndDate
    )
    SELECT
      CONCAT(@OrdNumber, '-OP', CAST(OperNumber AS varchar(20))),
      @OrdType,
      @OrdNumber,
      OperNumber,
      OperSequenceNumber,
      PathNumber,
      WcCode,
      OperCode,
      OperDescription,
      ISNULL(@QuantityOrdered, QuantityOrdered),
      ISNULL(@QuantityReported, QuantityReported),
      BatchSize,
      QueueTime,
      MoveTime,
      ProcessingTime,
      @StartDate,
      @EndDate
    FROM aps.SourceProductionOperations
    WHERE OrdNumber = @RtgNumber;
  END

  SELECT @OrdNumber AS OrdNumber;
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_BPL_DeleteWIBPL
  @IncludeDepended bit,
  @OrdType nvarchar(50),
  @OrdNumber nvarchar(50)
AS
BEGIN
  SET NOCOUNT ON;

  DELETE FROM aps.BPL_Src_WIOrders WHERE OrdType = @OrdType AND OrdNumber = @OrdNumber;
  DELETE FROM aps.BPL_Src_WIOperations WHERE OrdType = @OrdType AND OrdNumber = @OrdNumber;
  DELETE FROM aps.BPL_Src_WIMaterials WHERE OrdType = @OrdType AND OrdNumber = @OrdNumber;

  RETURN 1;
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_BPL_LogSchedulingInfo
  @performSourceSP bit,
  @TypeID nvarchar(50),
  @OrdType nvarchar(50),
  @OrdNumber nvarchar(50),
  @IsHeader bit,
  @OperNumber int,
  @PathNumber int,
  @ParPathNumber int,
  @OperSequenceNumber int,
  @RecType nvarchar(50),
  @OperType nvarchar(50),
  @SrcStartDate datetime,
  @SrcEndDate datetime,
  @SrcWcCode nvarchar(50),
  @SrcWcDeptCode nvarchar(50),
  @IsScheduled bit,
  @StartDate datetime,
  @EndDate datetime,
  @WcID int,
  @WcErpCode nvarchar(50),
  @WcErpDeptCode nvarchar(50),
  @FIXEDTIME_StartDate datetime,
  @FIXEDTIME_EndDate datetime,
  @FIXEDTIME_FinishedDiscretes decimal(18,6),
  @FIXEDTIME_InProcessDiscretes decimal(18,6),
  @PRODUCTION_StartDate datetime,
  @PRODUCTION_EndDate datetime,
  @PRODUCTION_FinishedDiscretes decimal(18,6),
  @PRODUCTION_InProcessDiscretes decimal(18,6),
  @RUN_StartDate datetime,
  @RUN_EndDate datetime,
  @RUN_FinishedDiscretes decimal(18,6),
  @RUN_InProcessDiscretes decimal(18,6),
  @SETUP_StartDate datetime,
  @SETUP_EndDate datetime,
  @SETUP_FinishedDiscretes decimal(18,6),
  @SETUP_InProcessDiscretes decimal(18,6),
  @PROCESSING_StartDate datetime,
  @PROCESSING_EndDate datetime,
  @PROCESSING_FinishedDiscretes decimal(18,6),
  @PROCESSING_InProcessDiscretes decimal(18,6),
  @PROCESSING2_StartDate datetime,
  @PROCESSING2_EndDate datetime,
  @PROCESSING2_FinishedDiscretes decimal(18,6),
  @PROCESSING2_InProcessDiscretes decimal(18,6),
  @SchedChangeByUser nvarchar(100),
  @ExtSyncMthd nvarchar(100),
  @ExtSyncParam nvarchar(100),
  @ExtSyncStamp nvarchar(100),
  @ExtSyncState nvarchar(100),
  @ExtSyncMsg nvarchar(1000),
  @SchedChangeBySQLUser nvarchar(100) OUTPUT,
  @PrevID int OUTPUT,
  @CurrID int OUTPUT,
  @IsScheduleChanged bit OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  SET @SchedChangeBySQLUser = ORIGINAL_LOGIN();
  SET @PrevID = NULL;

  SELECT TOP 1 @PrevID = ID
  FROM aps.BPL_Src_SchedulingInfoLog
  WHERE TypeID = @TypeID
    AND OrdType = @OrdType
    AND OrdNumber = @OrdNumber
    AND ISNULL(OperNumber, -1) = ISNULL(@OperNumber, -1)
    AND ISNULL(PathNumber, -1) = ISNULL(@PathNumber, -1)
    AND ISNULL(OperSequenceNumber, -1) = ISNULL(@OperSequenceNumber, -1)
  ORDER BY ID DESC;

  INSERT INTO aps.BPL_Src_SchedulingInfoLog (
    TypeID, OrdType, OrdNumber, IsHeader, OperNumber, PathNumber, ParPathNumber,
    OperSequenceNumber, RecType, OperType, SrcStartDate, SrcEndDate, SrcWcCode,
    SrcWcDeptCode, IsScheduled, StartDate, EndDate, WcID, WcErpCode, WcErpDeptCode,
    FIXEDTIME_StartDate, FIXEDTIME_EndDate, FIXEDTIME_FinishedDiscretes, FIXEDTIME_InProcessDiscretes,
    PRODUCTION_StartDate, PRODUCTION_EndDate, PRODUCTION_FinishedDiscretes, PRODUCTION_InProcessDiscretes,
    RUN_StartDate, RUN_EndDate, RUN_FinishedDiscretes, RUN_InProcessDiscretes,
    SETUP_StartDate, SETUP_EndDate, SETUP_FinishedDiscretes, SETUP_InProcessDiscretes,
    PROCESSING_StartDate, PROCESSING_EndDate, PROCESSING_FinishedDiscretes, PROCESSING_InProcessDiscretes,
    PROCESSING2_StartDate, PROCESSING2_EndDate, PROCESSING2_FinishedDiscretes, PROCESSING2_InProcessDiscretes,
    SchedChangeByUser, SchedChangeBySQLUser, ExtSyncMthd, ExtSyncParam, ExtSyncStamp, ExtSyncState, ExtSyncMsg
  )
  VALUES (
    @TypeID, @OrdType, @OrdNumber, @IsHeader, @OperNumber, @PathNumber, @ParPathNumber,
    @OperSequenceNumber, @RecType, @OperType, @SrcStartDate, @SrcEndDate, @SrcWcCode,
    @SrcWcDeptCode, @IsScheduled, @StartDate, @EndDate, @WcID, @WcErpCode, @WcErpDeptCode,
    @FIXEDTIME_StartDate, @FIXEDTIME_EndDate, @FIXEDTIME_FinishedDiscretes, @FIXEDTIME_InProcessDiscretes,
    @PRODUCTION_StartDate, @PRODUCTION_EndDate, @PRODUCTION_FinishedDiscretes, @PRODUCTION_InProcessDiscretes,
    @RUN_StartDate, @RUN_EndDate, @RUN_FinishedDiscretes, @RUN_InProcessDiscretes,
    @SETUP_StartDate, @SETUP_EndDate, @SETUP_FinishedDiscretes, @SETUP_InProcessDiscretes,
    @PROCESSING_StartDate, @PROCESSING_EndDate, @PROCESSING_FinishedDiscretes, @PROCESSING_InProcessDiscretes,
    @PROCESSING2_StartDate, @PROCESSING2_EndDate, @PROCESSING2_FinishedDiscretes, @PROCESSING2_InProcessDiscretes,
    @SchedChangeByUser, @SchedChangeBySQLUser, @ExtSyncMthd, @ExtSyncParam, @ExtSyncStamp, @ExtSyncState, @ExtSyncMsg
  );

  SET @CurrID = SCOPE_IDENTITY();

  DECLARE @PrevIsScheduled bit = NULL;
  DECLARE @PrevStartDate datetime = NULL;
  DECLARE @PrevEndDate datetime = NULL;
  DECLARE @PrevWcID int = NULL;
  DECLARE @PrevSrcStartDate datetime = NULL;
  DECLARE @PrevSrcEndDate datetime = NULL;

  SELECT
    @PrevIsScheduled = IsScheduled,
    @PrevStartDate = StartDate,
    @PrevEndDate = EndDate,
    @PrevWcID = WcID,
    @PrevSrcStartDate = SrcStartDate,
    @PrevSrcEndDate = SrcEndDate
  FROM aps.BPL_Src_SchedulingInfoLog
  WHERE ID = @PrevID;

  SET @IsScheduleChanged = CASE
    WHEN @PrevID IS NULL AND ISNULL(@IsScheduled, 0) = 1 THEN 1
    WHEN @PrevID IS NOT NULL AND (
      ISNULL(@PrevIsScheduled, 0) <> ISNULL(@IsScheduled, 0)
      OR ISNULL(@PrevStartDate, '19000101') <> ISNULL(@StartDate, '19000101')
      OR ISNULL(@PrevEndDate, '19000101') <> ISNULL(@EndDate, '19000101')
      OR ISNULL(@PrevWcID, -1) <> ISNULL(@WcID, -1)
      OR ISNULL(@PrevSrcStartDate, '19000101') <> ISNULL(@SrcStartDate, '19000101')
      OR ISNULL(@PrevSrcEndDate, '19000101') <> ISNULL(@SrcEndDate, '19000101')
    ) THEN 1
    ELSE 0
  END;

  IF @performSourceSP = 1
  BEGIN
    EXEC aps.Lynq_VP_SourceLogSchedulingInfo @PrevID, @CurrID;
  END
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_SourceLogSchedulingInfo
  @PrevID int,
  @CurrID int
AS
BEGIN
  SET NOCOUNT ON;

  SELECT
    prevLog.ID AS PrevID,
    currLog.ID AS CurrID,
    currLog.TypeID,
    currLog.OrdType,
    currLog.OrdNumber,
    currLog.OperNumber,
    currLog.PathNumber,
    currLog.OperSequenceNumber,
    currLog.IsScheduled,
    currLog.StartDate,
    currLog.EndDate,
    currLog.WcID,
    CASE
      WHEN prevLog.ID IS NULL AND ISNULL(currLog.IsScheduled, 0) = 1 THEN CAST(1 AS bit)
      WHEN prevLog.ID IS NOT NULL AND (
        ISNULL(prevLog.IsScheduled, 0) <> ISNULL(currLog.IsScheduled, 0)
        OR ISNULL(prevLog.StartDate, '19000101') <> ISNULL(currLog.StartDate, '19000101')
        OR ISNULL(prevLog.EndDate, '19000101') <> ISNULL(currLog.EndDate, '19000101')
        OR ISNULL(prevLog.WcID, -1) <> ISNULL(currLog.WcID, -1)
      ) THEN CAST(1 AS bit)
      ELSE CAST(0 AS bit)
    END AS IsScheduleChanged
  FROM aps.BPL_Src_SchedulingInfoLog currLog
  LEFT JOIN aps.BPL_Src_SchedulingInfoLog prevLog ON prevLog.ID = @PrevID
  WHERE currLog.ID = @CurrID;
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_BPL_spApplyWorkCentreParams
  @WcID int,
  @IsAllowedForSchedule bit
AS
BEGIN
  SET NOCOUNT ON;

  DELETE FROM aps.BPL_Src_WorkCentreParams WHERE ISNULL(WcID, -1) = ISNULL(@WcID, -1);

  IF @IsAllowedForSchedule = 1
  BEGIN
    INSERT INTO aps.BPL_Src_WorkCentreParams (WcID, IsAllowedForSchedule)
    VALUES (@WcID, @IsAllowedForSchedule);
  END
END
GO

CREATE OR ALTER PROCEDURE aps.Lynq_VP_BPL_spSchedulerRecordSummary_DeleteClosedOperations
  @DayOffset int
AS
BEGIN
  SET NOCOUNT ON;

  DELETE summaryRow
  FROM aps.SchedulerRecordSummary summaryRow
  INNER JOIN aps.VP_SourceProductionOperationsView operationRow
    ON summaryRow.OrdNumber = operationRow.OrdNumber
   AND summaryRow.OrdSchedType = operationRow.TypeID
   AND ISNULL(summaryRow.OperNumber, -1) = ISNULL(operationRow.OperNumber, -1)
   AND ISNULL(summaryRow.OperSequenceNumber, -1) = ISNULL(operationRow.OperSequenceNumber, -1)
   AND ISNULL(summaryRow.PathNumber, -1) = ISNULL(operationRow.PathNumber, -1)
  INNER JOIN aps.VP_SourceProductionOrdersView orderRow
    ON orderRow.OrdNumber = operationRow.OrdNumber
  WHERE summaryRow.OrdSchedType IN ('ProductionOperation', 'WOO', 'WOT')
    AND summaryRow.SummaryDate >= CONVERT(date, DATEADD(day, @DayOffset, GETDATE()))
    AND (
      orderRow.StatusCode1 IN ('Closed', 'Canceled', 'Ended', 'C', 'X', 'E', 'Complete')
      OR operationRow.CompletenessFlag IN ('C', 'Y', 'Complete')
    );
END
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_aps_SourceProductionOrders_OrdNumber'
    AND object_id = OBJECT_ID('aps.SourceProductionOrders')
)
BEGIN
  CREATE INDEX IX_aps_SourceProductionOrders_OrdNumber
  ON aps.SourceProductionOrders (OrdNumber);
END
GO

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_aps_SourceProductionOperations_OrdNumber_OperNumber'
    AND object_id = OBJECT_ID('aps.SourceProductionOperations')
)
BEGIN
  CREATE INDEX IX_aps_SourceProductionOperations_OrdNumber_OperNumber
  ON aps.SourceProductionOperations (OrdNumber, OperNumber);
END
GO

/*
  Optional refresh after deployment:
  EXEC aps.RefreshLynqCompatProductionCache;
*/
/* ============================================================
   Scheduler-owned persistence (NOT LYNQ mirror objects).
   The app writes schedules and what-if scenarios here. These are
   also created automatically on connect by ensureSysproObjects.ts,
   but are included here so a manual install fully provisions a new
   company database.
   ============================================================ */
GO

IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL
BEGIN
  CREATE TABLE aps.SavedSchedules (
    ScheduleID     nvarchar(80)  NOT NULL CONSTRAINT PK_aps_SavedSchedules PRIMARY KEY,
    ScheduleData   nvarchar(max) NOT NULL,
    Status         nvarchar(20)  NOT NULL CONSTRAINT DF_aps_SavedSchedules_Status DEFAULT ('Draft'),
    JobCount       int           NULL,
    OperationCount int           NULL,
    HorizonStart   datetime      NULL,
    HorizonEnd     datetime      NULL,
    GeneratedAt    datetime      NULL,
    SavedAt        datetime      NOT NULL CONSTRAINT DF_aps_SavedSchedules_SavedAt DEFAULT (GETDATE()),
    IsLatest       bit           NOT NULL CONSTRAINT DF_aps_SavedSchedules_IsLatest DEFAULT (0)
  );
  CREATE INDEX IX_aps_SavedSchedules_Latest ON aps.SavedSchedules (IsLatest, SavedAt DESC);
  PRINT 'aps.SavedSchedules created.';
END
ELSE
  PRINT 'aps.SavedSchedules already exists - skipped.';
GO

IF OBJECT_ID('aps.Scenarios', 'U') IS NULL
BEGIN
  CREATE TABLE aps.Scenarios (
    ScenarioId     nvarchar(80)  NOT NULL CONSTRAINT PK_aps_Scenarios PRIMARY KEY,
    BaseScheduleId nvarchar(80)  NULL,
    Name           nvarchar(120) NOT NULL,
    Description    nvarchar(500) NULL,
    ScheduleData   nvarchar(max) NOT NULL,
    Status         nvarchar(20)  NOT NULL CONSTRAINT DF_aps_Scenarios_Status DEFAULT ('Draft'),
    CreatedBy      nvarchar(100) NULL,
    CreatedAt      datetime2     NOT NULL CONSTRAINT DF_aps_Scenarios_CreatedAt DEFAULT (SYSUTCDATETIME()),
    PromotedAt     datetime2     NULL
  );
  CREATE INDEX IX_aps_Scenarios_Base ON aps.Scenarios (BaseScheduleId);
  PRINT 'aps.Scenarios created.';
END
ELSE
  PRINT 'aps.Scenarios already exists - skipped.';
GO
