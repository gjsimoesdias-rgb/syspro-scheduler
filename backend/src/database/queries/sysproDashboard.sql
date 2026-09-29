/**
 * Syspro database query definitions
 * Note: Table names may vary by Syspro version - adjust as needed
 */

export const SYSPRO_QUERIES = {
  // ==================== WORK ORDERS ====================
  getOpenJobs: `
    SELECT 
      wm.Job as jobId,
      wm.StockCode as itemCode,
      ISNULL(NULLIF(wm.JobDescription, ''), wm.StockDescription) as description,
      ISNULL(wm.QtyToMake, 0) as quantity,
      ISNULL(wm.JobDeliveryDate, ISNULL(wm.SchEndDate, GETDATE())) as dueDate,
      ISNULL(wm.JobStartDate, ISNULL(wm.SchStartDate, GETDATE())) as releaseDate,
      TRY_CONVERT(int, wm.Priority) as priority,
      CASE
        WHEN wm.Complete = 'Y' THEN 'Complete'
        WHEN wm.HoldFlag = 'Y' THEN 'OnHold'
        WHEN wm.ConfirmedFlag = 'Y' THEN 'Released'
        ELSE 'Firm'
      END as status,
      ISNULL(wm.ExpMaterial, 0) as estimatedMaterialCost,
      wm.*
    FROM WipMaster wm
    WHERE ISNULL(wm.Complete, 'N') <> 'Y'
    ORDER BY ISNULL(TRY_CONVERT(int, wm.Priority), 5) ASC, ISNULL(wm.JobDeliveryDate, wm.SchEndDate) ASC
  `,

  getJobById: `
    SELECT 
      wm.Job as jobId,
      wm.StockCode as itemCode,
      ISNULL(NULLIF(wm.JobDescription, ''), wm.StockDescription) as description,
      ISNULL(wm.QtyToMake, 0) as quantity,
      ISNULL(wm.JobDeliveryDate, ISNULL(wm.SchEndDate, GETDATE())) as dueDate,
      ISNULL(wm.JobStartDate, ISNULL(wm.SchStartDate, GETDATE())) as releaseDate,
      TRY_CONVERT(int, wm.Priority) as priority,
      CASE
        WHEN wm.Complete = 'Y' THEN 'Complete'
        WHEN wm.HoldFlag = 'Y' THEN 'OnHold'
        WHEN wm.ConfirmedFlag = 'Y' THEN 'Released'
        ELSE 'Firm'
      END as status,
      ISNULL(wm.ExpMaterial, 0) as estimatedMaterialCost,
      wm.*
    FROM WipMaster wm
    WHERE wm.Job = @jobId
  `,

  // ==================== OPERATIONS / ROUTING ====================
  getOperationsByJob: `
    SELECT 
      CONCAT(l.Job, '-OP', CAST(CAST(l.Operation as int) as varchar(20))) as opId,
      l.Job as jobId,
      CAST(l.Operation as int) as sequence,
      ISNULL(l.WorkCentre, ISNULL(l.IMachine, 'WC-UNKNOWN')) as workcentreId,
      ISNULL(NULLIF(l.WorkCentreDesc, ''), ISNULL(l.WorkCentre, 'Unknown')) as workcentreName,
      ISNULL(l.IExpUnitRunTim, 0) as duration,
      ISNULL(l.IExpSetUpTime, 0) as setupTime,
      ISNULL(l.QueueTime, 0) as queueTime,
      ISNULL(l.MovementTime, 0) as moveTime,
      ISNULL(NULLIF(l.IQuantity, 0), 1) as batchSize,
      ISNULL(l.OperationStatus, 'N') as status,
      l.ScheduledMachine,
      l.IMachine,
      l.*
    FROM WipJobAllLab l
    WHERE l.Job = @jobId
    ORDER BY CAST(l.Operation as int) ASC
  `,

  getOperationResources: `
    SELECT DISTINCT
      wr.RouteId as opId,
      r.ResourceId,
      r.ResourceName,
      r.ResourceType,
      r.WorkCentreCode as worcentreId,
      STRING_AGG(s.SkillCode, ',') as skillTags
    FROM SY_WorkOrderRouting wr
    LEFT JOIN SY_ResourceWorkcentre rw ON wr.WorkCentreCode = rw.WorkCentreCode
    LEFT JOIN SY_Resource r ON rw.ResourceId = r.ResourceId
    LEFT JOIN SY_ResourceSkill s ON r.ResourceId = s.ResourceId
    WHERE wr.WorkOrderId = @jobId
    GROUP BY wr.RouteId, r.ResourceId, r.ResourceName, r.ResourceType, r.WorkCentreCode
  `,

  // ==================== WORKCENTRES ====================
  getWorkcentres: `
    SELECT 
      wc.WorkCentreCode as worcentreId,
      wc.Description as name,
      wc.CentreType as description,
      STRING_AGG(c.Capability, ',') as capabilities,
      wc.CostPerHour as costPerHour,
      ISNULL(wc.MaxOvertimePerDay, 3.0) as maxOvertimePerDay,
      wc.CalendarId as calendarId
    FROM SY_Worcentre wc
    LEFT JOIN SY_WorkcentreCapability c ON wc.WorkCentreCode = c.WorkCentreCode
    WHERE wc.IsActive = 1
    GROUP BY wc.WorkCentreCode, wc.Description, wc.CentreType, wc.CostPerHour, wc.MaxOvertimePerDay, wc.CalendarId
    ORDER BY wc.Description ASC
  `,

  getWorkcentreById: `
    SELECT 
      wc.WorkCentreCode as worcentreId,
      wc.Description as name,
      wc.CentreType as description,
      wc.CostPerHour as costPerHour,
      ISNULL(wc.MaxOvertimePerDay, 3.0) as maxOvertimePerDay,
      wc.CalendarId as calendarId
    FROM SY_Worcentre wc
    WHERE wc.WorkCentreCode = @worcentreId
  `,

  // ==================== RESOURCES / EMPLOYEES ====================
  getResources: `
    SELECT 
      r.ResourceId as resourceId,
      r.ResourceName as name,
      r.ResourceType as type,
      r.WorkCentreCode as worcentreId,
      r.CostPerHour as costPerHour,
      STRING_AGG(s.SkillCode, ',') as skillTags,
      r.[Status] as status,
      r.CalendarId as calendarId
    FROM SY_Resource r
    LEFT JOIN SY_ResourceSkill s ON r.ResourceId = s.ResourceId
    WHERE r.IsActive = 1
    GROUP BY r.ResourceId, r.ResourceName, r.ResourceType, r.WorkCentreCode, r.CostPerHour, r.[Status], r.CalendarId
    ORDER BY r.ResourceName ASC
  `,

  getResourcesByWorkcentre: `
    SELECT 
      r.ResourceId as resourceId,
      r.ResourceName as name,
      r.ResourceType as type,
      r.WorkCentreCode as worcentreId,
      r.CostPerHour as costPerHour,
      STRING_AGG(s.SkillCode, ',') as skillTags,
      r.[Status] as status
    FROM SY_Resource r
    LEFT JOIN SY_ResourceSkill s ON r.ResourceId = s.ResourceId
    WHERE r.WorkCentreCode = @worcentreId AND r.IsActive = 1
    GROUP BY r.ResourceId, r.ResourceName, r.ResourceType, r.WorkCentreCode, r.CostPerHour, r.[Status]
  `,

  // ==================== MATERIALS / BOM ====================
  getMaterialsByJob: `
    SELECT 
      b.BOMLineId as bomId,
      b.ParentItemCode as itemCode,
      b.ComponentItemCode as componentCode,
      b.QuantityRequired as quantityRequired,
      b.UnitOfMeasure as unitOfMeasure,
      ISNULL(b.ScrapFactor, 0) as scrapFactor,
      i.StockQuantity as stockQty,
      ISNULL(i.ReservedQuantity, 0) as reservedQty
    FROM SY_BOMLine b
    LEFT JOIN SY_Inventory i ON b.ComponentItemCode = i.ItemCode
    WHERE b.ParentItemCode = @itemCode
    ORDER BY b.Sequence ASC
  `,

  getInventory: `
    SELECT 
      i.ItemCode as materialId,
      i.ItemCode as code,
      i.Description as description,
      i.UnitOfMeasure as unitOfMeasure,
      i.StockQuantity as stockQty,
      ISNULL(i.ReservedQuantity, 0) as reservedQty,
      ISNULL(i.LeadTimeDays, 0) as leadTimeDays,
      ISNULL(i.MinimumOrderQuantity, 1) as minimumOrderQty
    FROM SY_Inventory i
    WHERE i.IsActive = 1
    ORDER BY i.Description ASC
  `,

  // ==================== CALENDARS ====================
  getWorkingCalendar: `
    SELECT 
      c.CalendarId as calendarId,
      c.CalendarName as name,
      STRING_AGG(CAST(cd.DayOfWeek AS VARCHAR), ',') as workingDays,
      c.WorkingHoursPerDay as workingHoursPerDay
    FROM SY_Calendar c
    LEFT JOIN SY_CalendarDay cd ON c.CalendarId = cd.CalendarId AND cd.IsWorking = 1
    WHERE c.IsActive = 1
    GROUP BY c.CalendarId, c.CalendarName, c.WorkingHoursPerDay
  `,

  getHolidays: `
    SELECT 
      ch.HolidayId as holidayId,
      ch.HolidayDate as date,
      ch.HolidayName as name,
      ISNULL(ch.IsWorking, 0) as isWorking
    FROM SY_CalendarHoliday ch
    WHERE ch.CalendarId = @calendarId
    ORDER BY ch.HolidayDate ASC
  `,

  getShifts: `
    SELECT 
      s.ShiftId as shiftId,
      s.ShiftName as name,
      s.StartTime as startTime,
      s.EndTime as endTime,
      ISNULL(s.BreakTimeMins, 0) as breakTime
    FROM SY_Shift s
    WHERE s.CalendarId = @calendarId
    ORDER BY s.StartTime ASC
  `,

  // ==================== SETUP / SEQUENCE ====================
  getSetupSequences: `
    SELECT 
      ss.FromItemCode as fromItemCode,
      ss.ToItemCode as toItemCode,
      ss.SetupTimeMinutes as setupTimeMinutes
    FROM SY_SetupSequence ss
    WHERE ss.WorkCentreCode = @worcentreId
  `,

  // ==================== EXISTING SCHEDULE ====================
  getExistingSchedule: `
    SELECT 
      r.RouteId as opId,
      r.WorkOrderId as jobId,
      r.ScheduledStartDate as plannedStartDate,
      r.ScheduledEndDate as plannedEndDate,
      r.AssignedResourceId as resourceId
    FROM SY_WorkOrderRouting r
    WHERE r.ScheduledStartDate IS NOT NULL
      AND r.ScheduledEndDate >= CAST(GETDATE() AS DATE)
  `
};

export default SYSPRO_QUERIES;
