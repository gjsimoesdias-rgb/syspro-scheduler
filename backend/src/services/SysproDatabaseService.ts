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

const mapDatabaseFields = (row: Record<string, any>): Record<string, unknown> => {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    passthrough[key] = value ?? null;
  }
  return passthrough;
};

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
      masterJobId: row.masterJobId ?? row.MasterJob ?? null,
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
    const setupMinutes = (Number(row.setupTime) || 0) * 60;
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
      row.status || 'NotStarted'
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
      batchSize: Number(row.batchSize) || 1,
      qualifiedResourceIds: resourceIds,
      status: row.status || 'NotStarted',
      plannedStartDate,
      plannedEndDate,
      assignedResourceId: scheduledMachine || iMachine || undefined,
      ScheduledMachine: scheduledMachine,
      IMachine: iMachine
    });

    return operation;
  }

  // ==================== JOBS & OPERATIONS ====================

  async getOpenJobs(): Promise<Job[]> {
    try {
      // If configured to use APS views, read from scheduler-owned cache
      if (environment.useApsViews) {
        return this.getOpenJobsFromAPS();
      }

      // Otherwise, read from Syspro source tables
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getOpenJobs);
      const jobs: Job[] = [];

      for (const row of result.recordset) {
        const operations = await this.getOperationsByJob(row.jobId);
        const job = this.mapRowToJob(row, operations);
        jobs.push(job);
      }

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

      const jobs: Job[] = [];
      for (const row of result.recordset) {
        const operations = await this.getOperationsByJobFromAPS(row.jobId);
        const job = this.mapRowToJob(row, operations);
        jobs.push(job);
      }

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
   * Fetch ALL open-job WIP allocations grouped by (jobId, componentCode) in a
   * single query. Returns a map: jobId → Map<componentCode, heldQty>.
   *
   * Used by getJobMaterialPlans to avoid an N+1 (one query per job).
   */
  async getAllOpenJobAllocations(): Promise<Map<string, Map<string, number>>> {
    try {
      const result = await this.sysproDb.query(SYSPRO_QUERIES.getAllJobAllocations);
      const byJob = new Map<string, Map<string, number>>();
      for (const row of result.recordset || []) {
        const jobId = String(row.jobId || '').trim();
        const code = String(row.componentCode || '').trim();
        if (!jobId || !code) continue;
        if (!byJob.has(jobId)) byJob.set(jobId, new Map());
        byJob.get(jobId)!.set(code, (byJob.get(jobId)!.get(code) || 0) + (Number(row.heldQty) || 0));
      }
      return byJob;
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching all job allocations, falling back empty');
      return new Map();
    }
  }

  /**
   * Sums of in-flight component requirements held by every open job
   * except the one being viewed. Used to subtract from "global stock"
   * so the BOM modal reflects what's actually free for the current job.
   */
  async getOpenJobAllocations(
    excludeJobId: string
  ): Promise<Array<{ componentCode: string; heldQty: number }>> {
    try {
      const result = await this.sysproDb.queryWithParams(SYSPRO_QUERIES.getOpenJobAllocations, {
        excludeJobId: excludeJobId || '',
      });
      return (result.recordset || []).map((row: any) => ({
        componentCode: String(row.componentCode || '').trim(),
        heldQty: Number(row.heldQty) || 0,
      }));
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching open-job allocations, falling back empty');
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
   * Build a per-job material plan for an arbitrary list of jobs.
   *
   * Used by both the `/jobs/material-plan` and `/jobs/:jobId/bom-detail`
   * routes, and by the scheduling engine to enforce material availability
   * during placement. All three paths must produce the same numbers, so
   * the formula lives here in one place.
   *
   * Formula per BOM line:
   *   requiredQty   = quantityPerUnit * jobQty * (1 + scrapFactor)
   *   onHandTotal   = sum of qtyOnHand across warehouses
   *   wipAlloc      = sum of qtyAllocWip
   *   soAlloc       = sum of qtyAllocSO
   *   otherJobsHold = WipJobAllocation outstanding qty for OTHER open jobs
   *   freeOnHand    = max(0, onHandTotal - wipAlloc - soAlloc - otherJobsHold)
   *   incomingQty   = sum of outstanding PO receipts
   *   availableQty  = freeOnHand + incomingQty
   *
   * Job status: Materials if every line OK, No Materials if every line empty,
   * Partial otherwise.
   */
  async getJobMaterialPlans(jobs: Job[], scheduledOrder?: string[]): Promise<Map<string, JobMaterialPlan>> {
    if (!jobs.length) return new Map();

    const [warehouseRows, poReceipts, allJobAllocations] = await Promise.all([
      this.getInventoryByWarehouse(),
      this.getOpenPoReceipts(),
      this.getAllOpenJobAllocations(),
    ]);

    // Aggregate per-component once across the whole job list.
    const onHandByCode = new Map<string, number>();
    const allocByCode = new Map<string, number>();
    for (const row of warehouseRows) {
      onHandByCode.set(row.code, (onHandByCode.get(row.code) || 0) + row.qtyOnHand);
      allocByCode.set(
        row.code,
        (allocByCode.get(row.code) || 0) + row.qtyAllocWip + row.qtyAllocSO
      );
    }

    // PO receipts are kept as raw list so we can filter per-job by need date
    // (#62 time-phased material check). Only receipts whose promiseDate falls
    // on or before the job's need date count as "incoming" for that job.
    // Jobs with no releaseDate / dueDate default to counting all receipts
    // (conservative: better to show green than spuriously block scheduling).

    // When scheduledOrder is provided, process jobs in schedule sequence so
    // each job's BOM requirements deplete the shared pool for later jobs.
    // Only jobs WITHOUT WIP picks are accumulated in scheduleConsumed —
    // jobs with WIP picks are already captured in otherHoldsByCode via
    // allJobAllocations, so double-counting is avoided.
    const orderedJobs: Job[] = scheduledOrder
      ? [...jobs].sort((a, b) => {
          const ia = scheduledOrder.indexOf(String(a.jobId));
          const ib = scheduledOrder.indexOf(String(b.jobId));
          return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
        })
      : jobs;

    // Running tally of component quantities consumed by earlier-scheduled
    // jobs (those without WIP picks) that will reduce later jobs' availability.
    const scheduleConsumed = new Map<string, number>();

    const result = new Map<string, JobMaterialPlan>();

    for (const job of orderedJobs) {
      const jobId = String(job.jobId);
      const hasWipPicks = allJobAllocations.has(jobId);

      // Need date = earliest of releaseDate and dueDate, falling back to now.
      const needDate: Date = (() => {
        const r = job.releaseDate instanceof Date ? job.releaseDate : (job.releaseDate ? new Date(job.releaseDate as any) : null);
        const d = job.dueDate instanceof Date ? job.dueDate : (job.dueDate ? new Date(job.dueDate as any) : null);
        if (r && d) return r < d ? r : d;
        return r || d || new Date();
      })();

      // Only count PO receipts promised on or before the need date (#62).
      const incomingByCode = new Map<string, number>();
      for (const r of poReceipts) {
        if (r.promiseDate && r.promiseDate > needDate) continue; // arrives too late
        incomingByCode.set(
          r.componentCode,
          (incomingByCode.get(r.componentCode) || 0) + r.outstandingQty
        );
      }

      const otherHoldsByCode = new Map<string, number>();
      for (const [otherJobId, codeMap] of allJobAllocations) {
        if (otherJobId === jobId) continue;
        for (const [code, qty] of codeMap) {
          otherHoldsByCode.set(code, (otherHoldsByCode.get(code) || 0) + qty);
        }
      }

      const bomLines = await this.getMaterialsByJob(
        String((job as any).itemCode || jobId),
        jobId
      ).catch(() => [] as BOMLine[]);

      if (!bomLines.length) {
        result.set(jobId, {
          jobId,
          itemCode: (job as any).itemCode,
          status: 'Materials',
          available: true,
          shortages: [],
        });
        // Nothing to consume — advance to next job.
        continue;
      }

      const orderQty = Math.max(1, Number((job as any).quantity) || 1);
      const shortages: JobMaterialShortage[] = [];
      let okCount = 0;
      let partialCount = 0;
      let shortCount = 0;

      // Collect this job's BOM requirements for pool-depletion tracking.
      const reqsForThisJob = new Map<string, number>();

      for (const line of bomLines) {
        const code = String(line.componentCode || '').trim();
        if (!code) continue;

        const onHand = onHandByCode.get(code) || 0;
        const alloc = allocByCode.get(code) || 0;
        const otherHold = otherHoldsByCode.get(code) || 0;
        const incoming = incomingByCode.get(code) || 0;
        // Quantities consumed by earlier-scheduled jobs that haven't been
        // picked from inventory yet (schedule-order depletion, #62).
        const consumed = scheduledOrder ? (scheduleConsumed.get(code) || 0) : 0;

        const free = Math.max(0, onHand - alloc - otherHold - consumed);
        const availableQty = free + incoming;

        const scrap = Math.max(0, Number(line.scrapFactor) || 0);
        const requiredQty = Math.max(
          0,
          (Number(line.quantityRequired) || 0) * orderQty * (1 + scrap)
        );
        reqsForThisJob.set(code, (reqsForThisJob.get(code) || 0) + requiredQty);

        const shortageQty = Math.max(0, requiredQty - availableQty);

        if (requiredQty === 0 || availableQty >= requiredQty) {
          okCount++;
          continue;
        }
        if (availableQty > 0) {
          partialCount++;
        } else {
          shortCount++;
        }
        shortages.push({
          componentCode: code,
          requiredQty,
          availableQty,
          shortageQty,
          unitOfMeasure: line.unitOfMeasure,
        });
      }

      // Accumulate this job's requirements in the depletion pool so that
      // later-scheduled jobs see reduced availability.  Only jobs without
      // WIP picks are tracked here — jobs with WIP picks are already
      // captured in allJobAllocations / otherHoldsByCode.
      if (scheduledOrder && !hasWipPicks) {
        for (const [code, qty] of reqsForThisJob) {
          scheduleConsumed.set(code, (scheduleConsumed.get(code) || 0) + qty);
        }
      }

      const status: JobMaterialPlan['status'] =
        shortCount === 0 && partialCount === 0
          ? 'Materials'
          : okCount === 0 && partialCount === 0
          ? 'No Materials'
          : 'Partial';

      result.set(jobId, {
        jobId,
        itemCode: (job as any).itemCode,
        status,
        available: status === 'Materials',
        shortages,
      });
    }

    return result;
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

  private async getSetupSequences(worcentreId: string): Promise<SetupSequence[]> {
    try {
      const result = await this.sysproDb.queryWithParams(
        SYSPRO_QUERIES.getSetupSequences,
        { worcentreId }
      );
      return result.recordset.map((row: any) => ({
        fromItemCode: row.fromItemCode,
        toItemCode: row.toItemCode,
        setupTimeMinutes: row.setupTimeMinutes
      }));
    } catch (error) {
      logger.warn({ err: error, worcentreId }, 'Error fetching setup sequences, falling back empty');
      return [];
    }
  }
}

export default SysproDatabaseService;
