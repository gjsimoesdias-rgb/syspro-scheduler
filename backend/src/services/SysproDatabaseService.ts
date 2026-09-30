/**
 * SysproDatabaseService - Extracts and transforms data from Syspro database
 * Can optionally read from APS schema views for scheduler-owned data
 */

import DatabaseConnection from '../database/connection';
import { SYSPRO_QUERIES } from '../database/queries/sysproDashboard';
import { logger } from '../utils/logger';
import { resolveMasterLinks } from '../utils/jobIdNormalization';
import {
  JobModel,
  OperationModel,
  WorkcentreModel,
  ResourceModel,
  MaterialModel,
  CalendarModel
} from '../models';
import {
  Job,
  Operation,
  Workcentre,
  Resource,
  Material,
  BOMLine,
  Calendar,
  SetupSequence
} from '../types';

/** A single shortage row inside a JobMaterialPlan. */
export interface JobMaterialShortage {
  componentCode: string;
  requiredQty: number;
  availableQty: number;
  shortageQty: number;
  unitOfMeasure?: string;
}

/** Per-job material availability summary used by the scheduler and the BOM modal. */
export interface JobMaterialPlan {
  jobId: string;
  itemCode?: string;
  status: 'Materials' | 'Partial' | 'No Materials';
  /** True iff every BOM line is OK; false when any line is short or partial. */
  available: boolean;
  shortages: JobMaterialShortage[];
}
import environment from '../config/environment';
import { computeMaterialPlans, RequirementLine } from './materialPlan';

/**
 * Operation status from SYSPRO. On this install WipJobAllLab.OperationStatus is
 * blank for every op; the real completion flag is OperCompleted = 'Y'. Reading
 * only OperationStatus meant completed operations were never recognised and
 * got rescheduled.
 */
/** First non-blank value of a scalar or duplicated-column array; null when none has a letter/digit. */
const firstLinkValue = (value: unknown): string | null => {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    const text = String(v ?? '').trim();
    if (/[A-Za-z0-9]/.test(text) && !/^0+$/.test(text)) return text;
  }
  return null;
};

/** SYSPRO char keys come back space-padded; compare jobs on the trimmed id. */
const jobKey = (value: unknown): string => String(value ?? '').trim();

export const deriveOperationStatus = (row: Record<string, any>): 'NotStarted' | 'InProgress' | 'Complete' => {
  if (String(row.OperCompleted ?? '').trim().toUpperCase() === 'Y') return 'Complete';
  const s = String(row.status ?? '').trim();
  if (s === 'Complete' || s === 'InProgress') return s;
  return 'NotStarted';
};

/** SYSPRO ElapsedTime unit for subcontract ops (days by default; set SUBCONTRACT_ELAPSED_UNIT=hours if yours is in hours). */
const ELAPSED_MINUTES_PER_UNIT =
  (process.env.SUBCONTRACT_ELAPSED_UNIT || 'days').toLowerCase().startsWith('hour') ? 60 : 24 * 60;

/**
 * Subcontract (outside) operations — WipJobAllLab.SubcontractOp = 'Y'. They take
 * elapsed calendar time at the supplier and must not book an internal machine.
 */
export const subcontractFields = (row: Record<string, any>): Record<string, unknown> => {
  const isSub = String(row.SubcontractOp ?? '').trim().toUpperCase() === 'Y';
  if (!isSub) return { isSubcontract: false };
  const elapsed = Number(row.ElapsedTime);
  return {
    isSubcontract: true,
    subcontractSupplier: String(row.SubSupplier ?? '').trim() || undefined,
    elapsedMinutes: Number.isFinite(elapsed) && elapsed > 0 ? elapsed * ELAPSED_MINUTES_PER_UNIT : undefined,
  };
};

const mapDatabaseFields = (row: Record<string, any>): Record<string, unknown> => {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    passthrough[key] = value ?? null;
  }
  return passthrough;
};

/**
 * SYSPRO per-operation transfer (overlap): TransferQtyOrPct = 'P' → percent
 * of the run, 'Q' → a quantity out of the operation quantity. Returns the
 * share of this op's run after which the next op may start, or undefined
 * when there is no usable transfer (blank, 0, or the whole quantity).
 */
export function sysproTransferFraction(row: Record<string, any>, opQty?: number): number | undefined {
  const kind = String(row?.TransferQtyOrPct ?? '').trim().toUpperCase();
  const value = Number(row?.TransferQtyPct);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  let f: number | undefined;
  if (kind === 'P') f = value / 100;
  else if (kind === 'Q') {
    const qty = Number(opQty) > 0 ? Number(opQty) : Number(row?.QtyToMake);
    f = qty > 0 ? value / qty : undefined;
  }
  return f !== undefined && f > 0 && f < 1 ? f : undefined;
}

export class SysproDatabaseService {
  constructor(private sysproDb: DatabaseConnection) {}

  private normalizeSysproTextValue(value: any): string {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const normalized = this.normalizeSysproTextValue(entry);
        if (normalized) return normalized;
      }
      return '';
    }

    const text = String(value ?? '').trim();
    if (!text) return '';

    const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
    return parts[0] || '';
  }

  private combineSysproDateTime(dateValue: any, timeValue?: any): Date | undefined {
    if (!dateValue) return undefined;

    const combined = new Date(dateValue);
    if (Number.isNaN(combined.getTime())) return undefined;

    if (timeValue === undefined || timeValue === null || String(timeValue).trim() === '') {
      return combined;
    }

    if (timeValue instanceof Date && !Number.isNaN(timeValue.getTime())) {
      combined.setHours(timeValue.getHours(), timeValue.getMinutes(), timeValue.getSeconds(), 0);
      return combined;
    }

    const raw = String(timeValue).trim();
    if (raw.includes(':')) {
      const [hours, minutes, seconds] = raw.split(':').map((value) => Number(value) || 0);
      combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), Math.max(0, Math.min(59, seconds || 0)), 0);
      return combined;
    }

    const digits = raw.replace(/\D/g, '').padStart(4, '0').slice(-4);
    const hours = Number(digits.slice(0, 2)) || 0;
    const minutes = Number(digits.slice(2, 4)) || 0;
    combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), 0, 0);
    return combined;
  }

  private mapRowToJob(row: Record<string, any>, operations: Operation[]): Job {
    const dueDateSource = row.JobDeliveryDate || row.jobDeliveryDate || row.dueDate || row.SchEndDate;
    const releaseDateSource = row.JobStartDate || row.jobStartDate || row.releaseDate || row.SchStartDate;

    const dueDate = this.combineSysproDateTime(dueDateSource, row.JobDeliveryTime || row.jobDeliveryTime) || new Date(dueDateSource || Date.now());
    const releaseDate = this.combineSysproDateTime(releaseDateSource, row.JobStartTime || row.jobStartTime || row.SchStartTime) || new Date(releaseDateSource || Date.now());

    const job = new JobModel(
      row.jobId,
      row.itemCode,
      row.description || 'N/A',
      Number(row.quantity) || 0,
      dueDate,
      releaseDate,
      Number(row.priority) || 5,
      row.status || 'Released',
      operations,
      Number(row.estimatedMaterialCost) || 0
    );

    Object.assign(job as any, mapDatabaseFields(row), {
      jobId: row.jobId,
      itemCode: row.itemCode,
      description: row.description || 'N/A',
      quantity: Number(row.quantity) || 0,
      dueDate,
      releaseDate,
      priority: Number(row.priority) || 5,
      status: row.status || 'Released',
      estimatedMaterialCost: Number(row.estimatedMaterialCost) || 0,
      // SYSPRO master/sub-job hierarchy (WipMasterSub) — used by the engine
      // to enforce "sub-jobs finish before the master starts" precedence.
      // wm.* plus the MasterJob alias makes mssql return MasterJob as an array
      // (['', null] -> String() = ","), so take the first real value.
      masterJobId: firstLinkValue(row.masterJobId) ?? firstLinkValue(row.MasterJob),
      isMasterJob: row.IsMasterJob === true || row.IsMasterJob === 1,
      isSubJob: row.IsSubJob === true || row.IsSubJob === 1
    });

    return job;
  }

  private mapRowToOperation(row: Record<string, any>): Operation {
    const scheduledMachine = this.normalizeSysproTextValue(row.ScheduledMachine);
    const iMachine = this.normalizeSysproTextValue(row.IMachine);
    const resourceIds = Array.from(new Set([scheduledMachine, iMachine].filter(Boolean)));

    const plannedStartDate = this.combineSysproDateTime(
      row.SchStartDate || row.StartDate || row.plannedStartDate,
      row.SchStartTime || row.StartTime
    );
    const plannedEndDate = this.combineSysproDateTime(
      row.SchEndDate || row.EndDate || row.plannedEndDate,
      row.SchEndTime || row.EndTime
    );

    // Syspro routing times are stored in hours; scheduler operates in minutes.
    // Run time must be the per-unit expected run time (IExpUnitRunTim) multiplied
    // by the parent job planned quantity (ParentQtyPlanned) — the total run time
    // for the whole quantity, not the per-unit figure. Prefer those raw columns
    // (present on both the WipJobAllLab and APS-view rows via SELECT *); fall back
    // to the pre-aliased `duration` if either column is missing.
    const unitRunHours = Number(row.IExpUnitRunTim);
    const parentQty = Number(row.ParentQtyPlanned);
    const runHours =
      Number.isFinite(unitRunHours) && unitRunHours > 0 && Number.isFinite(parentQty) && parentQty > 0
        ? unitRunHours * parentQty
        : (Number(row.duration) || 0);
    const durationMinutes = runHours * 60;
    // Startup time (IExpStartupTime) is machine time before the run — booked with setup.
    const setupMinutes = ((Number(row.setupTime) || 0) + (Number(row.IExpStartupTime) || 0)) * 60;
    const waitMinutes = Math.max(0, (Number(row.IWaitTime) || 0) * 60);
    const minorSetupMinutes = Math.max(0, (Number(row.MinorSetUp) || 0) * 60);
    const transferFraction = sysproTransferFraction(row, parentQty);
    const queueMinutes = (Number(row.queueTime) || 0) * 60;
    const moveMinutes = (Number(row.moveTime) || 0) * 60;

    const operation = new OperationModel(
      row.opId,
      row.jobId,
      Number(row.sequence) || 0,
      row.workcentreId || 'WC-UNKNOWN',
      row.workcentreName || 'Unknown',
      durationMinutes,
      setupMinutes,
      queueMinutes,
      moveMinutes,
      Number(row.batchSize) || 1,
      resourceIds,
      deriveOperationStatus(row)
    );

    Object.assign(operation as any, mapDatabaseFields(row), {
      opId: row.opId,
      jobId: row.jobId,
      sequence: Number(row.sequence) || 0,
      workcentreId: row.workcentreId || 'WC-UNKNOWN',
      workcentreName: row.workcentreName || 'Unknown',
      duration: durationMinutes,
      setupTime: setupMinutes,
      queueTime: queueMinutes,
      moveTime: moveMinutes,
      status: deriveOperationStatus(row),
      ...subcontractFields(row),
      batchSize: Number(row.batchSize) || 1,
      qualifiedResourceIds: resourceIds,
      waitTime: waitMinutes || undefined,
      minorSetupTime: minorSetupMinutes || undefined,
      transferFraction,
      plannedStartDate,
      plannedEndDate,
      assignedResourceId: scheduledMachine || iMachine || undefined,
      ScheduledMachine: scheduledMachine,
      IMachine: iMachine
    });

    return operation;
  }

  // ==================== JOBS & OPERATIONS ====================

  /** Group operation rows (already ordered by job, sequence) by trimmed job id. */
  private groupOperationsByJob(rows: any[]): Map<string, Operation[]> {
    const byJob = new Map<string, Operation[]>();
    for (const row of rows || []) {
      const key = jobKey(row.jobId);
      let list = byJob.get(key);
      if (!list) byJob.set(key, (list = []));
      list.push(this.mapRowToOperation(row));
    }
    return byJob;
  }

  async getOpenJobs(): Promise<Job[]> {
    try {
      // If configured to use APS views, read from scheduler-owned cache
      if (environment.useApsViews) {
        return this.getOpenJobsFromAPS();
      }

      // Otherwise, read from Syspro source tables — two set-based queries
      // (jobs + all their operations) instead of one query per job.
      const [result, opsResult] = await Promise.all([
        this.sysproDb.query(SYSPRO_QUERIES.getOpenJobs),
        this.sysproDb.query(SYSPRO_QUERIES.getOperationsForOpenJobs),
      ]);
      const opsByJob = this.groupOperationsByJob(opsResult.recordset);
      const jobs: Job[] = result.recordset.map((row: any) =>
        this.mapRowToJob(row, opsByJob.get(jobKey(row.jobId)) || []));

      // Master/sub links can come back in a different format than the job
      // keys (padding/trim differences). Rewrite them to exact jobId strings
      // so the engines' equality comparisons enforce precedence reliably.
      const linkStats = resolveMasterLinks(jobs);
      if (linkStats.resolved || linkStats.selfCleared) {
        logger.info(linkStats, 'Normalised master/sub-job links');
      }
      return jobs;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching open jobs');
      throw error;
    }
  }

  /**
   * Read open jobs from APS compatibility layer views
   * These are scheduler-owned copies of the Syspro production data
   */
  private async getOpenJobsFromAPS(): Promise<Job[]> {
    try {
      logger.debug('Reading jobs from APS views');

      const result = await this.sysproDb.query(`
        SELECT 
          po.ProductionOrderNumber as jobId,
          po.ItemNumber as itemCode,
          po.Description as description,
          po.QuantityOrdered as quantity,
          po.DueDate as dueDate,
          po.ReleaseDate as releaseDate,
          ISNULL(po.Priority, 5) as priority,
          ISNULL(po.Status, 'Released') as status,
          ISNULL(po.EstimatedMaterialCost, 0) as estimatedMaterialCost,
          NULLIF(LTRIM(RTRIM(po.ParentOrdNumber)), '') as masterJobId,
          CASE WHEN NULLIF(LTRIM(RTRIM(po.ParentOrdNumber)), '') IS NOT NULL
               THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END as IsSubJob,
          po.*
        FROM aps.VP_SourceProductionOrdersView po
        WHERE ISNULL(po.CancelledFlag, 0) = 0
        ORDER BY ISNULL(po.Priority, 5) ASC, po.DueDate ASC
      `);

      const opsResult = await this.sysproDb.query(`
        SELECT
          po.ProductionOperationNumber as opId,
          po.ProductionOrderNumber as jobId,
          po.SequenceNumber as sequence,
          po.WorkCentreCode as workcentreId,
          po.WorkCentreName as workcentreName,
          po.EstimatedRunTime as duration,
          po.EstimatedSetUpTime as setupTime,
          po.QueueTime as queueTime,
          po.MovementTime as moveTime,
          po.BatchSize as batchSize,
          po.OperationStatus as status,
          po.PrimaryResource as ScheduledMachine,
          po.AlternateResource as IMachine,
          po.*
        FROM aps.VP_SourceProductionOperationsView po
        ORDER BY po.ProductionOrderNumber ASC, po.SequenceNumber ASC
      `);
      const opsByJob = this.groupOperationsByJob(opsResult.recordset);
      const jobs: Job[] = result.recordset.map((row: any) =>
        this.mapRowToJob(row, opsByJob.get(jobKey(row.jobId)) || []));

      // Same normalisation as the direct-SYSPRO path — the compat layer
      // trims ParentOrdNumber, so links rarely match the padded job keys.
      const linkStats = resolveMasterLinks(jobs);
      if (linkStats.resolved || linkStats.selfCleared) {
        logger.info(linkStats, 'Normalised master/sub-job links (APS views)');
      }

      logger.info({ count: jobs.length }, 'Loaded jobs from APS views');
      return jobs;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching jobs from APS views');
      throw error;
    }
  }

  async getJobById(jobId: string): Promise<Job | null> {
    try {
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getJobById,
        { jobId }
      );
      if (!result.recordset.length) return null;

      const row = result.recordset[0];
      const operations = await this.getOperationsByJob(jobId);
      return this.mapRowToJob(row, operations);
    } catch (error) {
      logger.error({ err: error, jobId }, 'Error fetching job');
      throw error;
    }
  }

  async getOperationsByJob(jobId: string): Promise<Operation[]> {
    try {
      // If configured to use APS views, read from scheduler-owned cache
      if (environment.useApsViews) {
        return this.getOperationsByJobFromAPS(jobId);
      }

      // Otherwise, read from Syspro source tables
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getOperationsByJob,
        { jobId }
      );
      const operations: Operation[] = [];

      for (const row of result.recordset) {
        operations.push(this.mapRowToOperation(row));
      }
      return operations;
    } catch (error) {
      logger.error({ err: error, jobId }, 'Error fetching operations for job');
      throw error;
    }
  }

  /**
   * Read operations for a job from APS compatibility layer views
   */
  private async getOperationsByJobFromAPS(jobId: string): Promise<Operation[]> {
    try {
      const result = await this.sysproDb.queryWithParams(
        `
        SELECT 
          po.ProductionOperationNumber as opId,
          po.ProductionOrderNumber as jobId,
          po.SequenceNumber as sequence,
          po.WorkCentreCode as workcentreId,
          po.WorkCentreName as workcentreName,
          po.EstimatedRunTime as duration,
          po.EstimatedSetUpTime as setupTime,
          po.QueueTime as queueTime,
          po.MovementTime as moveTime,
          po.BatchSize as batchSize,
          po.OperationStatus as status,
          po.PrimaryResource as ScheduledMachine,
          po.AlternateResource as IMachine,
          po.*
        FROM aps.VP_SourceProductionOperationsView po
        WHERE po.ProductionOrderNumber = @jobId
        ORDER BY po.SequenceNumber ASC
        `,
        { jobId }
      );

      const operations: Operation[] = [];
      for (const row of result.recordset) {
        operations.push(this.mapRowToOperation(row));
      }
      return operations;
    } catch (error) {
      logger.error({ err: error, jobId }, 'Error fetching operations for job from APS');
      throw error;
    }
  }

  // ==================== WORKCENTRES ====================

  async getWorkcentres(): Promise<Workcentre[]> {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getWorkcentres);
      const workcentres: Workcentre[] = [];

      for (const row of result.recordset) {
        const calendar = await this.getCalendar(row.calendarId);
        const setupSeqs = await this.getSetupSequences(row.worcentreId);
        const wc = new WorkcentreModel(
          row.worcentreId,
          row.name,
          row.description || '',
          (row.capabilities || '').split(',').filter((c: string) => c),
          { name: 'Standard', shifts: [] },
          calendar,
          row.costPerHour || 0,
          row.maxOvertimePerDay || 3.0,
          setupSeqs
        );
        workcentres.push(wc);
      }
      return workcentres;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching workcentres');
      throw error;
    }
  }

  async getWorkcentreById(worcentreId: string): Promise<Workcentre | null> {
    try {
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getWorkcentreById,
        { worcentreId }
      );
      if (!result.recordset.length) return null;

      const row = result.recordset[0];
      const calendar = await this.getCalendar(row.calendarId);
      const setupSeqs = await this.getSetupSequences(worcentreId);
      return new WorkcentreModel(
        row.worcentreId,
        row.name,
        row.description || '',
        [],
        { name: 'Standard', shifts: [] },
        calendar,
        row.costPerHour || 0,
        row.maxOvertimePerDay || 3.0,
        setupSeqs
      );
    } catch (error) {
      logger.error({ err: error, worcentreId }, 'Error fetching workcentre by ID');
      throw error;
    }
  }

  // ==================== RESOURCES ====================

  async getResources(): Promise<Resource[]> {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getResources);
      const resources: Resource[] = [];

      for (const row of result.recordset) {
        const calendar = await this.getCalendar(row.calendarId);
        const resource = new ResourceModel(
          row.resourceId,
          row.name,
          row.type,
          row.worcentreId,
          (row.skillTags || '').split(',').filter((s: string) => s),
          row.costPerHour || 0,
          calendar,
          row.status || 'Available'
        );
        resources.push(resource);
      }
      return resources;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching resources');
      throw error;
    }
  }

  async getResourcesByWorkcentre(worcentreId: string): Promise<Resource[]> {
    try {
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getResourcesByWorkcentre,
        { worcentreId }
      );
      const resources: Resource[] = [];

      for (const row of result.recordset) {
        const calendar = await this.getCalendar(undefined);
        const resource = new ResourceModel(
          row.resourceId,
          row.name,
          row.type,
          row.worcentreId,
          (row.skillTags || '').split(',').filter((s: string) => s),
          row.costPerHour || 0,
          calendar,
          row.status || 'Available'
        );
        resources.push(resource);
      }
      return resources;
    } catch (error) {
      logger.error({ err: error, worcentreId }, 'Error fetching resources for workcentre');
      throw error;
    }
  }

  // ==================== MATERIALS ====================

  async getMaterialsByJob(itemCode: string, jobId?: string): Promise<BOMLine[]> {
    try {
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getMaterialsByJob,
        { itemCode, jobId: jobId || '' }
      );
      return result.recordset.map((row: any) => ({
        bomId: row.bomId,
        itemCode: row.itemCode,
        componentCode: row.componentCode,
        quantityRequired: Number(row.quantityRequired) || 0,
        unitOfMeasure: row.unitOfMeasure,
        scrapFactor: Number(row.scrapFactor) || 0
      }));
    } catch (error) {
      logger.error({ err: error, itemCode }, 'Error fetching BOM');
      throw error;
    }
  }

  async getInventory(): Promise<Material[]> {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getInventory);
      return result.recordset.map(
        (row: any) =>
          new MaterialModel(
            row.materialId,
            row.code,
            row.description,
            row.unitOfMeasure,
            row.stockQty,
            row.reservedQty,
            row.leadTimeDays,
            row.minimumOrderQty
          )
      );
    } catch (error) {
      logger.error({ err: error }, 'Error fetching inventory');
      throw error;
    }
  }

  /**
   * Per-warehouse stock breakdown. One row per (stockCode, warehouseCode)
   * with QtyOnHand, QtyAllocWip (open jobs), QtyAllocSO (sales orders).
   * Use this when you want to show planners exactly where the stock is.
   */
  async getInventoryByWarehouse(): Promise<
    Array<{
      code: string;
      description: string;
      unitOfMeasure: string;
      warehouseCode: string;
      qtyOnHand: number;
      qtyAllocWip: number;
      qtyAllocSO: number;
      leadTimeDays: number;
    }>
  > {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getInventoryByWarehouse);
      return (result.recordset || []).map((row: any) => ({
        code: String(row.code || '').trim(),
        description: String(row.description || '').trim(),
        unitOfMeasure: row.unitOfMeasure || 'EA',
        warehouseCode: String(row.warehouseCode || '(default)').trim(),
        qtyOnHand: Number(row.qtyOnHand) || 0,
        qtyAllocWip: Number(row.qtyAllocWip) || 0,
        qtyAllocSO: Number(row.qtyAllocSO) || 0,
        leadTimeDays: Number(row.leadTimeDays) || 0,
      }));
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching warehouse inventory, falling back empty');
      return [];
    }
  }

  /**
   * Outstanding material need of every open job (WipJobAllMat), grouped by job.
   * One query — replaces the per-job BOM lookups the plan used to do.
   */
  async getOpenJobMaterialRequirements(): Promise<Map<string, RequirementLine[]>> {
    const result = await this.sysproDb.query(SYSPRO_QUERIES.getOpenJobMaterialRequirements);
    const byJob = new Map<string, RequirementLine[]>();
    for (const row of result.recordset || []) {
      const jobId = String(row.jobId || '').trim();
      const componentCode = String(row.componentCode || '').trim();
      if (!jobId || !componentCode) continue;
      const required = Number(row.requiredQty) || 0;
      const issued = Number(row.issuedQty) || 0;
      const outstandingQty = Number(row.allocCompleted) === 1 ? 0 : Math.max(0, required - issued);
      const list = byJob.get(jobId) || [];
      list.push({
        jobId,
        componentCode,
        warehouseCode: String(row.warehouseCode || '').trim(),
        unitOfMeasure: row.unitOfMeasure || 'EA',
        outstandingQty,
      });
      byJob.set(jobId, list);
    }
    return byJob;
  }

  /**
   * Outstanding needs of every open job EXCEPT `excludeJobId`, summed per
   * component. The BOM modal subtracts this from stock to show what is left
   * for the job being viewed.
   */
  async getOpenJobAllocations(
    excludeJobId: string
  ): Promise<Array<{ componentCode: string; heldQty: number }>> {
    try {
      const reqs = await this.getOpenJobMaterialRequirements();
      const exclude = String(excludeJobId || '').trim();
      const byCode = new Map<string, number>();
      for (const [jobId, lines] of reqs) {
        if (jobId === exclude) continue;
        for (const l of lines) byCode.set(l.componentCode, (byCode.get(l.componentCode) || 0) + l.outstandingQty);
      }
      return Array.from(byCode, ([componentCode, heldQty]) => ({ componentCode, heldQty }));
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching open-job material needs, falling back empty');
      return [];
    }
  }

  /**
   * One row per outstanding PO line — feeds the "Incoming receipts"
   * panel. Includes promise/due dates so the UI can flag receipts
   * arriving after the job's planned start.
   */
  async getOpenPoReceipts(): Promise<
    Array<{
      componentCode: string;
      warehouseCode: string;
      poNumber: string;
      promiseDate: Date | null;
      dueDate: Date | null;
      outstandingQty: number;
    }>
  > {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getOpenPoReceipts);
      return (result.recordset || []).map((row: any) => ({
        componentCode: String(row.componentCode || '').trim(),
        warehouseCode: String(row.warehouseCode || '').trim(),
        poNumber: String(row.poNumber || '').trim(),
        promiseDate: row.promiseDate ? new Date(row.promiseDate) : null,
        dueDate: row.dueDate ? new Date(row.dueDate) : null,
        outstandingQty: Number(row.outstandingQty) || 0,
      }));
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching open PO receipts, falling back empty');
      return [];
    }
  }

  /**
   * Per-job material plan for a list of jobs — the single source used by the
   * scheduler (/generate, /optimize) and the /jobs/material-plan route.
   * The formula lives in services/materialPlan.ts (pure, unit-tested).
   *
   * @param scheduledOrder job ids in schedule order; earlier jobs consume
   *   shared stock first. Without it, the jobs' given (priority) order is used.
   */
  async getJobMaterialPlans(jobs: Job[], scheduledOrder?: string[]): Promise<Map<string, JobMaterialPlan>> {
    if (!jobs.length) return new Map();

    const [warehouseRows, poReceipts, requirementsByJob] = await Promise.all([
      this.getInventoryByWarehouse(),
      this.getOpenPoReceipts(),
      this.getOpenJobMaterialRequirements(),
    ]);

    // Jobs with no WipJobAllMat lines (e.g. bulk-imported jobs not in SYSPRO)
    // fall back to the product BOM: qty per × job qty × (1 + scrap).
    const missing = jobs.filter((j) => !requirementsByJob.has(String(j.jobId).trim()));
    // One BOM lookup per distinct item, not per job.
    const bomByItem = new Map<string, Promise<BOMLine[]>>();
    const bomFor = (job: Job) => {
      const item = String((job as any).itemCode || job.jobId);
      if (!bomByItem.has(item)) {
        // No jobId: these jobs have no WipJobAllMat lines, so passing the job
        // would query WipJobAllMat again and return nothing — go to the BOM.
        bomByItem.set(item, this.getMaterialsByJob(item).catch(() => [] as BOMLine[]));
      }
      return bomByItem.get(item)!;
    };
    for (const job of missing) {
      const lines = await bomFor(job);
      if (!lines.length) continue;
      const qty = Math.max(1, Number((job as any).quantity) || 1);
      requirementsByJob.set(
        String(job.jobId).trim(),
        lines.map((l: any) => ({
          jobId: String(job.jobId).trim(),
          componentCode: String(l.componentCode || '').trim(),
          warehouseCode: '',
          unitOfMeasure: l.unitOfMeasure,
          outstandingQty: (Number(l.quantityRequired) || 0) * qty * (1 + Math.max(0, Number(l.scrapFactor) || 0)),
        }))
      );
    }

    return computeMaterialPlans({
      jobs: jobs as any,
      requirementsByJob,
      stock: warehouseRows.map((w) => ({
        code: w.code,
        warehouseCode: w.warehouseCode === '(default)' ? '' : w.warehouseCode,
        qtyOnHand: w.qtyOnHand,
        qtyAllocSO: w.qtyAllocSO,
      })),
      poReceipts,
      order: scheduledOrder,
    }) as Map<string, JobMaterialPlan>;
  }

  // ==================== CALENDARS ====================

  private async getCalendar(calendarId?: string): Promise<Calendar> {
    try {
      const calendar = new CalendarModel(
        calendarId || 'default',
        'Default Calendar',
        [1, 2, 3, 4, 5], // Mon-Fri
        8 // 8 hours/day
      );
      return calendar;
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching calendar, using defaults');
      return new CalendarModel(
        'default',
        'Default Calendar',
        [1, 2, 3, 4, 5],
        8
      );
    }
  }

  // ==================== SETUP SEQUENCES ====================

  /**
   * Item-to-item setup sequences. SYSPRO has no such table; changeovers come
   * from the scheduler's own matrices (ConstraintManager / changeover matrix).
   * The old per-workcentre `WHERE 1=0` query cost one round trip per workcentre
   * and always returned nothing, so it is no longer called.
   */
  private async getSetupSequences(_worcentreId: string): Promise<SetupSequence[]> {
    return [];
  }
}

export default SysproDatabaseService;
