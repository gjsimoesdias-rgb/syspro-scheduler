/**
 * APSDatabaseService — Manages scheduler exports to APS schema (LYNQ-compatible layer).
 * Handles writing scheduled jobs, operations, and logging to scheduler-owned tables.
 * All multi-step writes are wrapped in a single transaction (see exportSchedule).
 */

import DatabaseConnection, { DbExecutor } from '../database/connection';
import { Schedule, JobSchedule, OperationSchedule } from '../types';
import { logger } from '../utils/logger';

export interface ExportResult {
  success: boolean;
  /** False when the LYNQ compatibility layer isn't installed: only WipMaster/WipJobAllLab were written. */
  lynqLayer?: boolean;
  schedulesWritten: number;
  operationsWritten: number;
  logsCreated: number;
  errorMessages: string[];
  executionTimeMs: number;
}

export class APSDatabaseService {
  constructor(private sysproDb: DatabaseConnection) {}

  private toSysproDateValue(dateValue: Date | string | number | undefined): string {
    const parsed = dateValue instanceof Date ? dateValue : new Date(dateValue as any);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid Syspro date value: ${String(dateValue)}`);
    }

    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T00:00:00`;
  }

  private toSysproTimeValue(dateValue: Date | string | number | undefined): number {
    if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
      return dateValue.getHours() * 100 + dateValue.getMinutes();
    }

    const parsed = new Date(dateValue as any);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getHours() * 100 + parsed.getMinutes();
    }

    const digits = String(dateValue ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4);
    const hours = Number(digits.slice(0, 2)) || 0;
    const minutes = Number(digits.slice(2, 4)) || 0;
    return Math.max(0, Math.min(23, hours)) * 100 + Math.max(0, Math.min(59, minutes));
  }

  private async getSourceOrderDetails(
    db: DbExecutor,
    jobId: string
  ): Promise<{
    itemNumber: string;
    locationCode: string;
    quantityOrdered: number;
    itemDescription: string;
  }> {
    const result = await db.queryWithParams(
      `
      SELECT TOP 1
        ItemNumber,
        LocationCode,
        QuantityOrdered,
        ItemDescription
      FROM aps.SourceProductionOrders
      WHERE OrdNumber = @jobId
      `,
      { jobId }
    );

    const row = result.recordset?.[0];
    return {
      itemNumber: row?.ItemNumber || jobId,
      locationCode: row?.LocationCode || 'MAIN',
      quantityOrdered: Number(row?.QuantityOrdered) || 1,
      itemDescription: row?.ItemDescription || `Schedule for Job ${jobId}`
    };
  }

  /** True when every object the LYNQ export steps call exists in this company DB. */
  private async lynqLayerPresent(): Promise<boolean> {
    try {
      // Names go in as parameters (keeps them out of the SQL text).
      const names = {
        o1: 'aps.RefreshLynqCompatProductionCache', o2: 'aps.Lynq_VP_BPL_CreateWIBPL',
        o3: 'aps.Lynq_VP_BPL_LogSchedulingInfo', o4: 'aps.SchedulerRecordSummary', o5: 'aps.SourceProductionOrders',
      };
      const r = await this.sysproDb.queryWithParams(
        `SELECT CASE WHEN OBJECT_ID(@o1) IS NOT NULL AND OBJECT_ID(@o2) IS NOT NULL AND OBJECT_ID(@o3) IS NOT NULL
                       AND OBJECT_ID(@o4) IS NOT NULL AND OBJECT_ID(@o5) IS NOT NULL
                THEN 1 ELSE 0 END AS present`,
        names
      );
      return Number(r.recordset?.[0]?.present) === 1;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the APS cache tables with latest data from Syspro WipMaster and WipJobAllLab
   * This ensures the VP_SourceProductionOrders/Operations views have current data
   */
  async refreshApsCache(): Promise<{ success: boolean; rowsRefreshed: number }> {
    try {
      logger.info('Refreshing APS cache from Syspro...');

      await this.sysproDb.query(
        'EXEC aps.RefreshLynqCompatProductionCache'
      );

      logger.info('APS cache refresh completed');
      return { success: true, rowsRefreshed: 0 };
    } catch (error) {
      logger.error({ err: error }, 'Error refreshing APS cache');
      throw error;
    }
  }

  /**
   * Export a complete schedule to APS tables via stored procedures.
   * Creates work-in-progress orders and logs scheduling info.
   *
   * All write operations (summary populate + APS sproc inserts + WipJobAllLab
   * UPDATE + WipMaster UPDATE) execute inside a single SQL transaction so
   * that a failure in any step rolls back the entire export. The cache
   * refresh runs *before* the transaction because it is a long-running,
   * idempotent operation that does not need to be undone.
   */
  /**
   * @param opts.onlyJobs incremental publish: write only these jobs to SYSPRO.
   *   The scheduler summary snapshot is still rebuilt from the whole schedule.
   */
  async exportSchedule(schedule: Schedule, opts: { onlyJobs?: Schedule['jobSchedules'] } = {}): Promise<ExportResult> {
    const toWrite: Schedule = opts.onlyJobs ? { ...schedule, jobSchedules: opts.onlyJobs } : schedule;
    const startTime = Date.now();
    const result: ExportResult = {
      success: true,
      schedulesWritten: 0,
      operationsWritten: 0,
      logsCreated: 0,
      errorMessages: [],
      executionTimeMs: 0
    };

    try {
      // The LYNQ compatibility layer (create_aps_lynq_compat_objects.sql) is
      // optional: without it we still write the schedule back to SYSPRO
      // (steps 4-5) and skip the LYNQ work-order / summary steps.
      const lynq = await this.lynqLayerPresent();
      result.lynqLayer = lynq;
      if (!lynq) {
        logger.warn('LYNQ compatibility objects not installed — writing WipMaster/WipJobAllLab only');
      }

      // Step 1: Refresh cache to ensure APS tables have latest Syspro data
      // (outside the transaction — idempotent and potentially slow)
      if (lynq) {
        logger.info('Export step 1: refreshing APS cache');
        await this.refreshApsCache();
      }

      // Steps 2-5 are atomic. Either every write lands in SYSPRO or none do.
      const txResult = await this.sysproDb.withTransaction(async (db) => {
        const innerResult = {
          schedulesWritten: 0,
          operationsWritten: 0,
          logsCreated: 0,
          errorMessages: [] as string[]
        };

        if (lynq) {
        logger.info('Export step 2: populating scheduler record summary');
        await this.populateSchedulerRecordSummary(db, schedule);

        logger.info({ count: toWrite.jobSchedules.length }, 'Export step 3: writing job schedules to APS');
        for (const jobSchedule of toWrite.jobSchedules) {
          const writeResult = await this.writeJobSchedule(db, jobSchedule, schedule);
          if (writeResult.success) {
            innerResult.schedulesWritten += writeResult.schedulesWritten;
            innerResult.operationsWritten += writeResult.operationsWritten;
            innerResult.logsCreated += writeResult.logsCreated;
          } else {
            // Throw to trigger rollback — no partial exports allowed.
            throw new Error(`Failed to write job ${jobSchedule.jobId}: ${writeResult.error}`);
          }
        }
        } else {
          innerResult.schedulesWritten = toWrite.jobSchedules.length;
          innerResult.operationsWritten = toWrite.jobSchedules.reduce(
            (n, j) => n + (j.operationSchedules?.length || 0), 0);
        }

        logger.info('Export step 4: writing operation changes to WipJobAllLab');
        await this.writeBackToWipJobAllLab(db, toWrite);

        logger.info('Export step 5: writing job changes to WipMaster');
        await this.writeBackToWipMaster(db, toWrite);

        return innerResult;
      });

      result.schedulesWritten = txResult.schedulesWritten;
      result.operationsWritten = txResult.operationsWritten;
      result.logsCreated = txResult.logsCreated;
      result.errorMessages = txResult.errorMessages;

      if (result.errorMessages.length > 0) {
        result.success = false;
        logger.warn({ warnings: result.errorMessages }, 'Export committed with non-fatal warnings');
      } else {
        logger.info({ schedulesWritten: result.schedulesWritten, operationsWritten: result.operationsWritten }, 'Export committed successfully');
      }
    } catch (error) {
      result.success = false;
      result.errorMessages.push((error as any).message || 'Unknown export error');
      logger.error({ err: error }, 'Fatal error during schedule export — transaction rolled back');
    }

    result.executionTimeMs = Date.now() - startTime;
    return result;
  }

  /**
   * Write a single job schedule to APS via Lynq_VP_BPL_CreateWIBPL procedure
   */
  private async writeJobSchedule(
    db: DbExecutor,
    jobSchedule: JobSchedule,
    schedule: Schedule
  ): Promise<{
    success: boolean;
    schedulesWritten: number;
    operationsWritten: number;
    logsCreated: number;
    error?: string;
  }> {
    try {
      const primaryOp = jobSchedule.operationSchedules[0];
      const sourceOrder = await this.getSourceOrderDetails(db, jobSchedule.jobId);
      const hasOperations = jobSchedule.operationSchedules.length > 0;

      const params = {
        IncludeDepended: hasOperations ? 1 : 0,
        OrdType: 'Schedule',
        ItemNumber: sourceOrder.itemNumber,
        LocCode: sourceOrder.locationCode,
        RtgNumber: jobSchedule.jobId,
        RtgVersion: '1',
        RtgRelease: 'A',
        QuantityOrdered: sourceOrder.quantityOrdered,
        QuantityReported: 0,
        StartDate: jobSchedule.plannedStartDate || new Date(),
        EndDate: jobSchedule.plannedEndDate || new Date(),
        Description1: sourceOrder.itemDescription,
        Description2: `Version: ${schedule.version || 1}, Status: ${schedule.status || 'Draft'}`
      };

      const queryStr = `
        EXEC aps.Lynq_VP_BPL_CreateWIBPL
          @IncludeDepended = @p_IncludeDepended,
          @OrdType = @p_OrdType,
          @ItemNumber = @p_ItemNumber,
          @LocCode = @p_LocCode,
          @RtgNumber = @p_RtgNumber,
          @RtgVersion = @p_RtgVersion,
          @RtgRelease = @p_RtgRelease,
          @QuantityOrdered = @p_QuantityOrdered,
          @QuantityReported = @p_QuantityReported,
          @StartDate = @p_StartDate,
          @EndDate = @p_EndDate,
          @Description1 = @p_Description1,
          @Description2 = @p_Description2;
      `;

      const result = await db.queryWithParams(queryStr, {
        p_IncludeDepended: params.IncludeDepended,
        p_OrdType: params.OrdType,
        p_ItemNumber: params.ItemNumber,
        p_LocCode: params.LocCode,
        p_RtgNumber: params.RtgNumber,
        p_RtgVersion: params.RtgVersion,
        p_RtgRelease: params.RtgRelease,
        p_QuantityOrdered: params.QuantityOrdered,
        p_QuantityReported: params.QuantityReported,
        p_StartDate: params.StartDate,
        p_EndDate: params.EndDate,
        p_Description1: params.Description1,
        p_Description2: params.Description2
      });

      if (result.recordset && result.recordset.length > 0) {
        const row = result.recordset[0];
        const createdOrdNumber = row.OrdNumber;
        logger.info({ ordNumber: createdOrdNumber, jobId: jobSchedule.jobId }, 'Created work order for job');

        let logsCreated = 0;
        if (primaryOp) {
          await this.logSchedulingInfo(db, jobSchedule, createdOrdNumber, schedule);
          logsCreated = 1;
        }

        return {
          success: true,
          schedulesWritten: 1,
          operationsWritten: jobSchedule.operationSchedules.length,
          logsCreated
        };
      }

      return {
        success: false,
        schedulesWritten: 0,
        operationsWritten: 0,
        logsCreated: 0,
        error: 'No output from CreateWIBPL procedure'
      };
    } catch (error) {
      logger.error({ err: error }, 'Error writing job schedule');
      return {
        success: false,
        schedulesWritten: 0,
        operationsWritten: 0,
        logsCreated: 0,
        error: (error as any).message
      };
    }
  }

  /**
   * Log scheduling information for a job to the BPL_Src_SchedulingInfoLog table.
   * Tracks what was scheduled, when, and by whom.
   */
  private async logSchedulingInfo(
    db: DbExecutor,
    jobSchedule: JobSchedule,
    ordNumber: string,
    schedule: Schedule
  ): Promise<void> {
    try {
      const now = new Date();
      const startDate = new Date(jobSchedule.plannedStartDate || now);
      const endDate   = new Date(jobSchedule.plannedEndDate   || now);
      const primaryOp = jobSchedule.operationSchedules[0];

      const queryStr = `
        DECLARE @PrevID INT = NULL;
        DECLARE @CurrID INT = NULL;
        DECLARE @IsScheduleChanged BIT = NULL;

        EXEC aps.Lynq_VP_BPL_LogSchedulingInfo
          @performSourceSP             = 0,
          @TypeID                      = @p_TypeID,
          @OrdType                     = @p_OrdType,
          @OrdNumber                   = @p_OrdNumber,
          @IsHeader                    = 1,
          @OperNumber                  = @p_OperNumber,
          @PathNumber                  = 0,
          @ParPathNumber               = 0,
          @OperSequenceNumber          = @p_OperNumber,
          @RecType                     = N'Operation',
          @OperType                    = N'Run',
          @SrcStartDate                = @p_StartDate,
          @SrcEndDate                  = @p_EndDate,
          @SrcWcCode                   = @p_WcCode,
          @SrcWcDeptCode               = N'',
          @IsScheduled                 = 1,
          @StartDate                   = @p_StartDate,
          @EndDate                     = @p_EndDate,
          @WcID                        = 0,
          @WcErpCode                   = @p_WcCode,
          @WcErpDeptCode               = N'',
          @FIXEDTIME_StartDate         = @p_StartDate,
          @FIXEDTIME_EndDate           = @p_EndDate,
          @FIXEDTIME_FinishedDiscretes = 0,
          @FIXEDTIME_InProcessDiscretes= 0,
          @PRODUCTION_StartDate        = @p_StartDate,
          @PRODUCTION_EndDate          = @p_EndDate,
          @PRODUCTION_FinishedDiscretes= 0,
          @PRODUCTION_InProcessDiscretes= 0,
          @RUN_StartDate               = @p_StartDate,
          @RUN_EndDate                 = @p_EndDate,
          @RUN_FinishedDiscretes       = 0,
          @RUN_InProcessDiscretes      = 0,
          @SETUP_StartDate             = @p_StartDate,
          @SETUP_EndDate               = @p_StartDate,
          @SETUP_FinishedDiscretes     = 0,
          @SETUP_InProcessDiscretes    = 0,
          @PROCESSING_StartDate        = @p_StartDate,
          @PROCESSING_EndDate          = @p_EndDate,
          @PROCESSING_FinishedDiscretes= 0,
          @PROCESSING_InProcessDiscretes= 0,
          @PROCESSING2_StartDate       = @p_StartDate,
          @PROCESSING2_EndDate         = @p_EndDate,
          @PROCESSING2_FinishedDiscretes= 0,
          @PROCESSING2_InProcessDiscretes= 0,
          @SchedChangeByUser           = @p_ChangedBy,
          @ExtSyncMthd                 = N'',
          @ExtSyncParam                = N'',
          @ExtSyncStamp                = N'',
          @ExtSyncState                = N'',
          @ExtSyncMsg                  = N'',
          @SchedChangeBySQLUser        = @p_ChangedBy,
          @PrevID                      = @PrevID OUTPUT,
          @CurrID                      = @CurrID OUTPUT,
          @IsScheduleChanged           = @IsScheduleChanged OUTPUT;

        SELECT @CurrID AS CurrID, @IsScheduleChanged AS IsScheduleChanged;
      `;

      await db.queryWithParams(queryStr, {
        p_TypeID:    'WO',
        p_OrdType:   'W',
        p_OrdNumber: ordNumber,
        p_OperNumber: 1,
        p_StartDate: startDate,
        p_EndDate:   endDate,
        p_WcCode:    String(primaryOp?.workcentreId || ''),
        p_ChangedBy: String(process.env.USER || 'SCHEDULER'),
      });

      logger.info({ ordNumber }, 'Logged scheduling info for order');
    } catch (error) {
      logger.warn({ err: error, ordNumber }, 'Could not log scheduling info for order (non-fatal)');
    }
  }

  /**
   * Populate the SchedulerRecordSummary table with a snapshot of current scheduled operations.
   *
   * Instead of one round-trip per operation (N+1), we build a single
   * parameterised multi-row INSERT that batches up to BATCH_SIZE rows at a
   * time — a dramatic reduction in network round-trips for large schedules.
   *
   * All values are fully parameterised — no string interpolation of user data.
   */
  private async populateSchedulerRecordSummary(db: DbExecutor, schedule: Schedule): Promise<void> {
    // Clear existing records for today (no user data; safe).
    await db.query(`
      DELETE FROM aps.SchedulerRecordSummary
      WHERE SummaryDate = CAST(GETDATE() AS DATE)
    `);

    // Flatten all operation schedules into a single list.
    interface Row {
      ordNumber: string;
      operNumber: number;
      seqIdx: number;
      wcCode: string;
      scheduledStart: string;
      scheduledEnd: string;
    }

    const rows: Row[] = [];
    for (const jobSchedule of schedule.jobSchedules) {
      for (let seqIdx = 0; seqIdx < jobSchedule.operationSchedules.length; seqIdx++) {
        const opSchedule = jobSchedule.operationSchedules[seqIdx];
        rows.push({
          ordNumber: this.truncate(jobSchedule.jobId, 50),
          operNumber: seqIdx + 1,
          seqIdx,
          wcCode: this.truncate(opSchedule.workcentreId, 50),
          scheduledStart: this.toIsoDate(opSchedule.plannedStartDate),
          scheduledEnd: this.toIsoDate(opSchedule.plannedEndDate),
        });
      }
    }

    if (rows.length === 0) return;

    // SQL Server supports up to 1000 rows per VALUES list; we batch at 500
    // to stay well within the 2100-parameter limit (9 params × 500 = 4500 —
    // but mssql passes params as named objects so the real limit is the row
    // count, not the parameter count; 500 is a safe conservative batch size).
    const BATCH_SIZE = 500;

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE);

      // Build: VALUES (@ordNumber0, …), (@ordNumber1, …), …
      const valueClauses = batch
        .map(
          (_, i) =>
            `(@ordNumber${i}, 'Finite Capacity', @operNumber${i}, @seqIdx${i}, ` +
            `CAST(GETDATE() AS DATE), @scheduledStart${i}, @scheduledEnd${i}, @wcCode${i})`
        )
        .join(',\n        ');

      const params: Record<string, unknown> = {};
      batch.forEach((row, i) => {
        params[`ordNumber${i}`]      = row.ordNumber;
        params[`operNumber${i}`]     = row.operNumber;
        params[`seqIdx${i}`]         = row.seqIdx;
        params[`scheduledStart${i}`] = row.scheduledStart;
        params[`scheduledEnd${i}`]   = row.scheduledEnd;
        params[`wcCode${i}`]         = row.wcCode;
      });

      await db.queryWithParams(
        `INSERT INTO aps.SchedulerRecordSummary
           (OrdNumber, OrdSchedType, OperNumber, OperSequenceNumber,
            SummaryDate, StartDate, EndDate, WcCode)
         VALUES
         ${valueClauses}`,
        params
      );
    }

    logger.info({ insertCount: rows.length }, 'Populated SchedulerRecordSummary');
  }

  /** Truncate a value to a maximum length (defensive against schema column limits). */
  private truncate(value: string | undefined, maxLength: number): string {
    return String(value || '').substring(0, maxLength);
  }

  /** Format date for SQL Server insertion (yyyy-mm-dd). */
  private toIsoDate(date: Date | undefined): string {
    if (!date) return new Date().toISOString().split('T')[0];
    return new Date(date).toISOString().split('T')[0];
  }

  /**
   * Clean up old scheduling records (closed/completed operations).
   * Called periodically to maintain summary table.
   */
  async cleanupClosedOperations(dayOffset = 0): Promise<{ rowsDeleted: number }> {
    try {
      const queryStr = `
        DECLARE @DeletedCount INT;
        EXEC aps.Lynq_VP_BPL_spSchedulerRecordSummary_DeleteClosedOperations
          @DayOffset = @p_DayOffset,
          @DeleteClosedOpsExecuted = @DeletedCount OUTPUT;
        SELECT @DeletedCount AS DeletedCount;
      `;

      const result = await this.sysproDb.queryWithParams(queryStr, {
        p_DayOffset: dayOffset
      });

      const rowsDeleted = result.recordset?.[0]?.DeletedCount || 0;
      logger.info({ rowsDeleted }, 'Cleaned up closed operations from summary');

      return { rowsDeleted };
    } catch (error) {
      logger.warn({ err: error }, 'Could not cleanup closed operations');
      return { rowsDeleted: 0 };
    }
  }

  private async writeBackToWipJobAllLab(db: DbExecutor, schedule: Schedule): Promise<void> {
    for (const jobSchedule of schedule.jobSchedules || []) {
      for (const op of jobSchedule.operationSchedules || []) {
        const opIdText = String(op.opId || '');
        const opMatch = opIdText.match(/OP(\d+)$/i);
        const sequence = Number((op as any).sequence || opMatch?.[1] || 0);
        if (!sequence) continue;

        const startDate = new Date(op.plannedStartDate);
        const endDate = new Date(op.plannedEndDate);
        const runStartDate = new Date((op as any).runStart || op.plannedStartDate);
        if (
          Number.isNaN(startDate.getTime()) ||
          Number.isNaN(endDate.getTime()) ||
          Number.isNaN(runStartDate.getTime())
        ) {
          throw new Error(`Invalid operation dates for ${jobSchedule.jobId}/${op.opId}`);
        }

        const machine = String(op.resourceId || op.workcentreId || '');
        if (!machine) {
          throw new Error(
            `Cannot write back ${jobSchedule.jobId}/${op.opId}: no resourceId or workcentreId — would orphan the SYSPRO row.`
          );
        }

        const result = await db.queryWithParams(
          `
          -- IMachine (the routing's machine) is deliberately NOT written: the
          -- loader reads {ScheduledMachine, IMachine} as the op's qualified
          -- machines, so overwriting IMachine pinned every op to wherever it
          -- was last scheduled and it could never move back.
          UPDATE WipJobAllLab
          SET
            ScheduledMachine   = @machine,
            SchStartDate       = @startDate,
            SchStartTime       = @startTime,
            SchEndDate         = @endDate,
            SchEndTime         = @endTime,
            SchStartRunDate    = @runStartDate,
            SchStartRunTime    = @runStartTime,
            -- Keep planned dates in sync with scheduled dates so MRP netting
            -- uses the correct window (mirrors LYNQ's OverwritePlannedDates path)
            PlannedStartDate   = @startDate,
            PlannedEndDate     = @endDate
          WHERE Job = @jobId
            AND Operation = @sequence;  -- numeric column: compare directly so the (Job, Operation) key is used

          SELECT @@ROWCOUNT AS rowsAffected;
          `,
          {
            machine,
            startDate: this.toSysproDateValue(startDate),
            startTime: this.toSysproTimeValue(startDate),
            endDate: this.toSysproDateValue(endDate),
            endTime: this.toSysproTimeValue(endDate),
            runStartDate: this.toSysproDateValue(runStartDate),
            runStartTime: this.toSysproTimeValue(runStartDate),
            jobId: jobSchedule.jobId,
            sequence
          }
        );

        const rowsAffected = Number(result.recordset?.[0]?.rowsAffected) || 0;
        if (rowsAffected < 1) {
          throw new Error(
            `No WipJobAllLab row updated for ${jobSchedule.jobId} operation ${sequence}`
          );
        }
      }
    }
  }

  private async writeBackToWipMaster(db: DbExecutor, schedule: Schedule): Promise<void> {
    for (const jobSchedule of schedule.jobSchedules || []) {
      const startDate = new Date(jobSchedule.plannedStartDate);
      const endDate = new Date(jobSchedule.plannedEndDate);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new Error(`Invalid job schedule dates for ${jobSchedule.jobId}`);
      }

      const result = await db.queryWithParams(
        `
        UPDATE WipMaster
        SET
          SchStartDate    = @startDate,
          SchStartTime    = @startTime,
          SchEndDate      = @endDate,
          SchEndTime      = @endTime,
          -- Mark job as user-scheduled (mirrors LYNQ ScheduleFlag='U' on WipMaster)
          ScheduleFlag    = 'U',
          -- Set calculation method to Manual so SYSPRO won't auto-recalculate dates
          -- (mirrors LYNQ DateCalcMethod='M')
          DateCalcMethod  = 'M'
          -- JobStartDate / JobDeliveryDate are deliberately NOT written:
          -- JobDeliveryDate is the customer due date and JobStartDate is read back
          -- as the job's release date, so overwriting them would erase the due date
          -- and stop the job ever moving earlier on the next run.
        WHERE Job = @jobId;

        SELECT @@ROWCOUNT AS rowsAffected;
        `,
        {
          startDate: this.toSysproDateValue(startDate),
          startTime: this.toSysproTimeValue(startDate),
          endDate: this.toSysproDateValue(endDate),
          endTime: this.toSysproTimeValue(endDate),
          jobId: jobSchedule.jobId
        }
      );

      const rowsAffected = Number(result.recordset?.[0]?.rowsAffected) || 0;
      if (rowsAffected < 1) {
        throw new Error(`No WipMaster row updated for job ${jobSchedule.jobId}`);
      }
    }
  }
}

export default APSDatabaseService;
