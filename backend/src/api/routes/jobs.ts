/**
 * Jobs API routes
 */

import { Router, Request, Response } from 'express';
import SysproDatabaseService from '../../services/SysproDatabaseService';
import { sysproServiceFor } from '../sysproServiceFor';
import { Job, Operation } from '../../types';
import { setLocal } from '../../utils/setLocal';
import { validateBody } from '../middleware/validateBody';
import { bulkImportJobsSchema, bulkImportOperationsSchema } from '../validators/jobValidators';
import { requirePlanner } from '../middleware/requireAuth';

const router = Router();

type ImportedJobPayload = {
  jobId: string;
  description?: string;
  dueDate: string | Date;
  quantity: number;
  priority?: string | number;
};

type ImportedOperationPayload = {
  jobId: string;
  opSequence: string;
  workcentreId: string;
  duration: number;
  setupTime?: number;
  movementTime?: number;
};

const toPriority = (value: string | number | undefined): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(10, value));
  const text = String(value || '').toLowerCase();
  if (text === 'high') return 1;
  if (text === 'normal' || text === 'medium') return 5;
  if (text === 'low') return 9;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 5;
};

const buildImportedOperation = (input: ImportedOperationPayload): Operation => {
  const sequence = Number(input.opSequence) || 10;
  return {
    opId: `${input.jobId}-OP${sequence}`,
    jobId: input.jobId,
    sequence,
    workcentreId: String(input.workcentreId || 'WC-IMPORTED'),
    workcentreName: String(input.workcentreId || 'Imported Workcentre'),
    duration: Math.max(1, Number(input.duration) || 60),
    setupTime: Math.max(0, Number(input.setupTime) || 0),
    queueTime: 0,
    moveTime: Math.max(0, Number(input.movementTime) || 0),
    batchSize: 1,
    qualifiedResourceIds: [],
    status: 'NotStarted'
  };
};

const createImportedJob = (input: ImportedJobPayload): Job => {
  const dueDate = new Date(input.dueDate);
  const safeDueDate = Number.isNaN(dueDate.getTime())
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    : dueDate;
  return {
    jobId: input.jobId,
    itemCode: input.jobId,
    description: input.description || `Imported ${input.jobId}`,
    quantity: Math.max(1, Number(input.quantity) || 1),
    dueDate: safeDueDate,
    releaseDate: new Date(),
    priority: toPriority(input.priority),
    status: 'Released',
    operations: [],
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0
  };
};

const buildMergedImportedJobs = (app: any): Job[] => {
  const importedJobs: Job[] = app.locals.importedJobs || [];
  const importedOps: ImportedOperationPayload[] = app.locals.importedOperations || [];

  const jobsMap = new Map<string, Job>(importedJobs.map((job) => [job.jobId, { ...job, operations: [...job.operations] }]));

  for (const op of importedOps) {
    if (!jobsMap.has(op.jobId)) {
      jobsMap.set(
        op.jobId,
        createImportedJob({
          jobId: op.jobId,
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          quantity: 1,
          priority: 'Normal',
          description: `Imported ${op.jobId}`
        })
      );
    }

    const target = jobsMap.get(op.jobId)!;
    const built = buildImportedOperation(op);
    const existingIndex = target.operations.findIndex((x) => x.sequence === built.sequence);
    if (existingIndex >= 0) {
      target.operations[existingIndex] = built;
    } else {
      target.operations.push(built);
    }
    target.operations.sort((a, b) => a.sequence - b.sequence);
  }

  for (const job of jobsMap.values()) {
    if (!job.operations.length) {
      job.operations = [
        {
          opId: `${job.jobId}-OP10`,
          jobId: job.jobId,
          sequence: 10,
          workcentreId: 'WC-IMPORTED',
          workcentreName: 'Imported Workcentre',
          duration: 60,
          setupTime: 0,
          queueTime: 0,
          moveTime: 0,
          batchSize: 1,
          qualifiedResourceIds: [],
          status: 'NotStarted'
        }
      ];
    }
  }

  const merged = Array.from(jobsMap.values());
  setLocal(app.locals, 'importedJobs', merged);
  // Best-effort persist — survives server restart. If the SCHEDULER DB
  // is unavailable, AppStateStore.set() warns and returns; the in-memory
  // cache above is still authoritative for this run.
  return merged;
};

/**
 * GET /api/jobs
 * Get all open jobs
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;

    // If database not connected, return empty list in read-only mode
    if (!sysproDb) {
      return res.json({
        count: 0,
        jobs: [],
        warning: 'Database not connected - running in read-only mode'
      });
    }

    const sysproService = await sysproServiceFor(req, sysproDb);
    const jobs = await sysproService.getOpenJobs();
    const importedJobs = buildMergedImportedJobs(req.app);
    const mergedJobs = [...jobs];
    for (const imported of importedJobs) {
      if (!mergedJobs.find((job) => job.jobId === imported.jobId)) {
        mergedJobs.push(imported);
      }
    }

    res.json({
      count: mergedJobs.length,
      jobs: mergedJobs
    });
  } catch (error) {
    const message = (error as any).message || 'Failed to load jobs';
    if (message.includes('Invalid object name')) {
      return res.json({
        count: 0,
        jobs: [],
        warning: 'Database connected, but WipMaster or WipJobAllLab was not found in this company database'
      });
    }
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/jobs/bulk-import
 * Import jobs from CSV payload
 */
router.post('/bulk-import', requirePlanner, validateBody(bulkImportJobsSchema), async (req: Request, res: Response) => {
  try {
    const payload: ImportedJobPayload[] = req.body.jobs;
    if (!payload.length) {
      return res.status(400).json({ error: 'No jobs supplied for import' });
    }

    const importedJobs: Job[] = req.app.locals.importedJobs || [];
    const jobsMap = new Map<string, Job>(importedJobs.map((job) => [job.jobId, job]));

    for (const item of payload) {
      if (!item?.jobId) continue;
      const existing = jobsMap.get(item.jobId);
      const next = createImportedJob(item);
      if (existing?.operations?.length) {
        next.operations = existing.operations;
      }
      jobsMap.set(item.jobId, next);
    }

    setLocal(req.app.locals, 'importedJobs', Array.from(jobsMap.values()));
    buildMergedImportedJobs(req.app);

    res.json({
      imported: payload.length,
      totalImportedJobs: req.app.locals.importedJobs.length
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to import jobs' });
  }
});

/**
 * POST /api/jobs/operations/bulk-import
 * Import operations from CSV payload
 */
router.post('/operations/bulk-import', requirePlanner, validateBody(bulkImportOperationsSchema), async (req: Request, res: Response) => {
  try {
    const payload: ImportedOperationPayload[] = req.body.operations;
    if (!payload.length) {
      return res.status(400).json({ error: 'No operations supplied for import' });
    }

    const importedOperations: ImportedOperationPayload[] = req.app.locals.importedOperations || [];
    const key = (o: ImportedOperationPayload) => `${o.jobId}::${o.opSequence}`;
    const opMap = new Map<string, ImportedOperationPayload>(importedOperations.map((op) => [key(op), op]));

    for (const item of payload) {
      if (!item?.jobId) continue;
      opMap.set(key(item), item);
    }

    setLocal(req.app.locals, 'importedOperations', Array.from(opMap.values()));
    const mergedJobs = buildMergedImportedJobs(req.app);

    res.json({
      imported: payload.length,
      totalImportedOperations: req.app.locals.importedOperations.length,
      totalImportedJobs: mergedJobs.length
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to import operations' });
  }
});

router.post('/material-plan', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.json({ count: 0, materials: [], jobStatuses: {}, warning: 'Database not connected' });
    }

    const sysproService = await sysproServiceFor(req, sysproDb);
    const inputJobs = Array.isArray(req.body?.jobs) ? req.body.jobs : await sysproService.getOpenJobs();
    const inventory = await sysproService.getInventory().catch(() => []);
    const inventoryByCode = new Map<string, any>(
      (inventory as any[]).map((item: any) => [String(item.code || item.materialId || '').trim(), item] as [string, any])
    );

    const poResult = await sysproDb.query(`
      BEGIN TRY
        IF OBJECT_ID('PorMasterDetail', 'U') IS NOT NULL
          SELECT
            MStockCode AS materialCode,
            SUM(ISNULL(MOrderQty, 0) - ISNULL(MReceivedQty, 0)) AS openQty
          FROM PorMasterDetail
          WHERE ISNULL(MComplete, 'N') <> 'Y'
          GROUP BY MStockCode;
        ELSE
          SELECT TOP 0 CAST('' AS varchar(50)) AS materialCode, CAST(0 AS decimal(18,4)) AS openQty;
      END TRY
      BEGIN CATCH
        SELECT TOP 0 CAST('' AS varchar(50)) AS materialCode, CAST(0 AS decimal(18,4)) AS openQty;
      END CATCH
    `).catch(() => ({ recordset: [] }));
    const poByCode = new Map<string, number>(
      (poResult.recordset || []).map((row: any) => [String(row.materialCode || '').trim(), Number(row.openQty) || 0] as [string, number])
    );

    const materials: any[] = [];
    const jobStatuses: Record<string, 'Materials' | 'Partial' | 'No Materials'> = {};

    for (const rawJob of inputJobs) {
      const job = rawJob as Job & Record<string, any>;
      const bomLines = await sysproService.getMaterialsByJob(
        String(job.itemCode || job.jobId || ''),
        String(job.jobId || '')
      ).catch(() => []);

      if (!bomLines.length) {
        jobStatuses[job.jobId] = 'Materials';
        continue;
      }

      let hasEnough = true;
      let hasSome = false;

      for (const line of bomLines) {
        const requiredQty = Math.max(0, Number(line.quantityRequired || 0) * Math.max(1, Number(job.quantity) || 1) * (1 + Number(line.scrapFactor || 0)));
        const stock = inventoryByCode.get(String(line.componentCode || '').trim()) as any;
        const stockOnHand = Number(stock?.stockQty) || 0;
        const reservedQty = Number(stock?.reservedQty) || 0;
        const openPoQty = Number(poByCode.get(String(line.componentCode || '').trim()) || 0);
        const availableQty = Math.max(0, stockOnHand - reservedQty) + Math.max(0, openPoQty);

        let status: 'Materials' | 'Partial' | 'No Materials' = 'No Materials';
        if (availableQty >= requiredQty) {
          status = 'Materials';
          hasSome = true;
        } else if (availableQty > 0) {
          status = 'Partial';
          hasEnough = false;
          hasSome = true;
        } else {
          hasEnough = false;
        }

        materials.push({
          jobId: job.jobId,
          itemCode: job.itemCode,
          componentCode: line.componentCode,
          description: (stock?.description || '').trim(),
          unitOfMeasure: line.unitOfMeasure,
          quantityRequired: requiredQty,
          stockOnHand,
          reservedQty,
          openPoQty,
          availableQty,
          status
        });
      }

      jobStatuses[job.jobId] = hasEnough ? 'Materials' : hasSome ? 'Partial' : 'No Materials';
    }

    res.json({ count: materials.length, materials, jobStatuses });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to build material plan' });
  }
});

/**
 * GET /api/jobs/:jobId/bom-detail
 *
 * Returns the BOM for one job with per-line material availability.
 *
 * Improvements over the original (2026-05-06):
 *  1. Stock pulled per-warehouse from InvWarehouse so the modal can show
 *     where the inventory actually sits.
 *  2. WipJobAllocation is consulted to subtract material already held by
 *     OTHER open jobs — the previous behaviour quietly overstated free
 *     stock when several jobs needed the same component.
 *  3. Open POs are returned as individual receipts (PO#, qty, promise date)
 *     so a planner can answer "covered by next week's PO?" without leaving
 *     the modal.
 *
 * Availability per BOM line:
 *   requiredQty   = quantityPerUnit * jobQty * (1 + scrapFactor)
 *   onHandTotal   = sum of qtyOnHand across warehouses
 *   wipAlloc      = sum of qtyAllocWip   (held by open jobs in SYSPRO)
 *   soAlloc       = sum of qtyAllocSO    (held by sales orders)
 *   otherJobsHold = WipJobAllocation outstanding qty for other open jobs
 *   freeOnHand    = max(0, onHandTotal - soAlloc - otherJobsHold)   (wipAlloc shown, not subtracted)
 *   incomingQty   = sum of outstanding PO receipts
 *   availableQty  = freeOnHand + incomingQty
 *   shortageQty   = max(0, requiredQty - availableQty)
 *
 * Status: Materials / Partial / No Materials at line and job level.
 */
router.get('/:jobId/bom-detail', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const sysproService = await sysproServiceFor(req, sysproDb);

    // 1. Resolve the job (need itemCode + quantity for BOM expansion).
    const job = await sysproService.getJobById(jobId).catch(() => null);
    if (!job) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    // 2. Fetch BOM lines for the job.
    const bomLines = await sysproService
      .getMaterialsByJob(String(job.itemCode || jobId), String(jobId))
      .catch(() => []);

    if (!bomLines.length) {
      return res.json({
        jobId,
        itemCode: job.itemCode,
        quantity: job.quantity,
        status: 'Materials',
        lineCount: 0,
        shortageCount: 0,
        lines: [],
        note: 'No BOM lines found for this job — assuming materials are not tracked.',
      });
    }

    // 3. Pull richer inventory + holds + PO receipts in parallel.
    const [warehouseRows, requirementsByJob, poReceipts] = await Promise.all([
      sysproService.getInventoryByWarehouse(),
      sysproService.getOpenJobMaterialRequirements().catch(() => new Map()),
      sysproService.getOpenPoReceipts(),
    ]);

    // Index per-component for O(1) lookup.
    const warehousesByCode = new Map<string, typeof warehouseRows>();
    for (const row of warehouseRows) {
      const code = row.code;
      if (!code) continue;
      const arr = warehousesByCode.get(code) || [];
      arr.push(row);
      warehousesByCode.set(code, arr);
    }

    // Outstanding needs of OTHER open jobs (same source as the scheduler), and
    // this job's own outstanding need per component (issued material excluded).
    const thisJobId = String(jobId).trim();
    const holdsByCode = new Map<string, number>();
    const ownOutstandingByCode = new Map<string, number>();
    for (const [otherJobId, reqLines] of requirementsByJob as Map<string, any[]>) {
      for (const l of reqLines) {
        const target = otherJobId === thisJobId ? ownOutstandingByCode : holdsByCode;
        target.set(l.componentCode, (target.get(l.componentCode) || 0) + (Number(l.outstandingQty) || 0));
      }
    }

    const receiptsByCode = new Map<string, typeof poReceipts>();
    for (const r of poReceipts) {
      const arr = receiptsByCode.get(r.componentCode) || [];
      arr.push(r);
      receiptsByCode.set(r.componentCode, arr);
    }

    // 4. Walk every BOM line and compute availability.
    const orderQty = Math.max(1, Number(job.quantity) || 1);
    let okCount = 0;
    let partialCount = 0;
    let shortCount = 0;

    const lines = bomLines.map((line: any) => {
      const code = String(line.componentCode || '').trim();
      const whs = warehousesByCode.get(code) || [];
      const incoming = receiptsByCode.get(code) || [];
      const otherJobsHold = holdsByCode.get(code) || 0;

      const onHandTotal = whs.reduce((s, w) => s + w.qtyOnHand, 0);
      const wipAlloc = whs.reduce((s, w) => s + w.qtyAllocWip, 0);
      const soAlloc = whs.reduce((s, w) => s + w.qtyAllocSO, 0);
      const description =
        whs.find((w) => w.description)?.description || line.description || '';
      const unitOfMeasure =
        line.unitOfMeasure || whs.find((w) => w.unitOfMeasure)?.unitOfMeasure || 'EA';
      const leadTimeDays = whs.find((w) => w.leadTimeDays > 0)?.leadTimeDays || 0;

      // QtyAllocatedWip is shown but NOT subtracted: it already includes every
      // open job's allocation, which otherJobsHold covers (subtracting both
      // double-counts and takes this job's own allocation from itself).
      const freeOnHand = Math.max(0, onHandTotal - soAlloc - otherJobsHold);
      const incomingQty = incoming.reduce((s, r) => s + r.outstandingQty, 0);
      const availableQty = freeOnHand + incomingQty;

      const scrap = Math.max(0, Number(line.scrapFactor) || 0);
      // Prefer the job's real outstanding need (required − issued) from
      // WipJobAllMat; fall back to qty-per × order qty for non-SYSPRO jobs.
      const requiredQty = ownOutstandingByCode.has(code)
        ? ownOutstandingByCode.get(code)!
        : Math.max(0, (Number(line.quantityRequired) || 0) * orderQty * (1 + scrap));
      const shortageQty = Math.max(0, requiredQty - availableQty);

      let status: 'Materials' | 'Partial' | 'No Materials';
      if (requiredQty === 0 || availableQty >= requiredQty) {
        status = 'Materials';
        okCount++;
      } else if (availableQty > 0) {
        status = 'Partial';
        partialCount++;
      } else {
        status = 'No Materials';
        shortCount++;
      }

      return {
        componentCode: code,
        description,
        unitOfMeasure,
        quantityPerUnit: Number(line.quantityRequired) || 0,
        scrapFactor: scrap,
        requiredQty,
        // Headline numbers (kept stable for older modal versions):
        stockOnHand: onHandTotal,
        // soAlloc + otherJobsHold rolled into one for the legacy
        // 'reservedQty' field so the modal can keep showing one column.
        reservedQty: soAlloc + otherJobsHold,
        openPoQty: incomingQty,
        availableQty,
        shortageQty,
        leadTimeDays,
        status,
        // New richer fields:
        wipAllocQty: wipAlloc,
        soAllocQty: soAlloc,
        otherJobsHoldQty: otherJobsHold,
        freeOnHandQty: freeOnHand,
        warehouses: whs.map((w) => ({
          warehouseCode: w.warehouseCode,
          qtyOnHand: w.qtyOnHand,
          qtyAllocWip: w.qtyAllocWip,
          qtyAllocSO: w.qtyAllocSO,
        })),
        incomingReceipts: incoming.map((r) => ({
          poNumber: r.poNumber,
          promiseDate: r.promiseDate ? r.promiseDate.toISOString() : null,
          dueDate: r.dueDate ? r.dueDate.toISOString() : null,
          outstandingQty: r.outstandingQty,
        })),
      };
    });

    const overallStatus: 'Materials' | 'Partial' | 'No Materials' =
      shortCount === 0 && partialCount === 0
        ? 'Materials'
        : okCount === 0 && partialCount === 0
        ? 'No Materials'
        : 'Partial';

    res.json({
      jobId,
      itemCode: job.itemCode,
      itemDescription: (job as any).description || (job as any).itemDescription || '',
      quantity: orderQty,
      dueDate: (job as any).dueDate || null,
      status: overallStatus,
      lineCount: lines.length,
      okCount,
      partialCount,
      shortageCount: shortCount,
      lines,
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to load BOM detail' });
  }
});

/**
 * GET /api/jobs/:jobId
 * Get job details
 */
router.get('/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const sysproService = new SysproDatabaseService(sysproDb);
    const job = await sysproService.getJobById(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/jobs/:jobId/operations
 * Get operations for a job
 */
router.get('/:jobId/operations', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const sysproService = new SysproDatabaseService(sysproDb);
    const operations = await sysproService.getOperationsByJob(jobId);

    res.json({
      jobId,
      count: operations.length,
      operations
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

// NOTE: POST /api/jobs/:jobId/update-schedule was removed (2026-07-07).
// It was a placeholder that returned success without persisting anything —
// a silent-success trap. Schedule changes persist via POST /api/schedule/save;
// SYSPRO writeback happens through /api/schedule/:id/export-to-syspro.

export default router;
