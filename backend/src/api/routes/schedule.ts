/**
 * Schedule API routes
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { createSchedulingEngine } from '../../services/ISchedulingEngine';
import type { EngineType } from '../../services/ISchedulingEngine';
import ConstraintManager from '../../services/ConstraintManager';
import SysproDatabaseService from '../../services/SysproDatabaseService';
import SettingsService from '../../services/SettingsService';
import APSDatabaseService from '../../services/APSDatabaseService';
import environment from '../../config/environment';
import { Job, ScheduleRequest, PinnedOperation } from '../../types';
import { validate, generateScheduleSchema, saveScheduleSchema, approveOverrideSchema, setupMatrixRowSchema, setupMatrixBulkSchema, setupClassBulkSchema, ctpRequestSchema, optimizeScheduleSchema } from '../validators/scheduleValidators';
import { computeCtp } from '../../services/CtpService';
import { applyCalendarExceptions } from '../../utils/calendarExceptions';
import { rankRuleResults, RULE_LABELS, ALL_RULES, type SchedulingRule, type RuleResult } from '../../services/RuleOptimizerService';
import { buildBomTree } from '../../services/BomTreeService';
import { setLocal } from '../../utils/setLocal';
import { completeJobFamilies } from '../../utils/jobFamilies';
import { stripCompletedOperations } from '../../utils/jobFilters';
import { AuditLogService } from '../../services/AuditLogService';
import { requireAuth, requirePlanner, AuthRequest } from '../middleware/requireAuth';
import { saveAsLatest, promoteToLatest } from '../../services/ScheduleStore';

const router = Router();

/** Hard stop for one scheduling run (SCHEDULE_WORKER_TIMEOUT_MS, default 10 min). */
const WORKER_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.SCHEDULE_WORKER_TIMEOUT_MS || '600000', 10)
);

/**
 * Run the scheduling engine in a worker thread and resolve with its schedule.
 * The worker is terminated if it runs past WORKER_TIMEOUT_MS, so a stuck run
 * can no longer hang the HTTP request (and the planner's screen) forever.
 */
export function runScheduleWorker(workerData: any, timeoutMs = WORKER_TIMEOUT_MS): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    // __dirname is .../dist/api/routes in production, .../src/api/routes in dev
    const isCompiled = __dirname.includes('dist');
    const workerPath = isCompiled
      ? path.resolve(__dirname, '../../services/scheduleWorker.js')
      : path.resolve(__dirname, '../../services/scheduleWorker.ts');
    const workerOptions: any = { workerData };
    if (!isCompiled) workerOptions.execArgv = ['--require', 'ts-node/register'];
    const worker = new Worker(workerPath, workerOptions);

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `Scheduling run stopped after ${Math.round(timeoutMs / 1000)} s. ` +
        'Try fewer jobs or a shorter horizon, or raise SCHEDULE_WORKER_TIMEOUT_MS.'
      )));
      void worker.terminate();
    }, timeoutMs);

    worker.on('message', (msg: any) =>
      finish(() => (msg.success ? resolve(msg.schedule) : reject(new Error(msg.error))))
    );
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`Scheduler worker exited with code ${code}`)));
    });
  });
}

const buildCapacityMaps = (
  app: any,
  resources: Array<{ resourceId: string; worcentreId: string }>
): { resourceCapacities: Map<string, number>; workcentreCapacities: Map<string, number> } => {
  const resourceCapacities = new Map<string, number>();
  const workcentreCapacities = new Map<string, number>();
  const definitions = app.locals.resourceDefinitions || {};

  for (const resource of resources) {
    const definition = definitions[resource.resourceId];
    const activated = definition?.activated !== false;
    const quantity = activated ? Math.max(1, Number(definition?.quantity || 1)) : 0;

    resourceCapacities.set(resource.resourceId, quantity);

    // Each workcentre (production line) processes ONE operation at a time,
    // regardless of how many machines it contains. The engine's
    // workcentre-level overlap check (capacity = 1) then serialises operations
    // on the line instead of running them in parallel across machines.
    workcentreCapacities.set(resource.worcentreId, 1);
  }

  return { resourceCapacities, workcentreCapacities };
};

const mergeImportedJobs = (app: any, jobs: Job[]): Job[] => {
  const importedJobs: Job[] = app.locals.importedJobs || [];
  if (!importedJobs.length) return jobs;

  const merged = [...jobs];
  for (const imported of importedJobs) {
    if (!merged.find((job) => job.jobId === imported.jobId)) {
      merged.push(imported);
    }
  }

  return merged;
};

const applyAssignedShiftCalendars = (app: any, resources: any[]) =>
  applyCalendarExceptions(applyShiftTemplates(app, resources), app.locals.calendarExceptions);

const applyShiftTemplates = (app: any, resources: any[]) => {
  const definitions = app.locals.resourceDefinitions || {};
  const shifts = app.locals.shiftTemplates || [];
  const shiftById = new Map<string, any>(shifts.map((shift: any) => [String(shift.shiftId), shift]));

  return resources.map((resource: any) => {
    const definition = definitions[resource.resourceId];
    const assignedShift: any = shiftById.get(String(definition?.shiftId || 'default'));
    if (!assignedShift) {
      return resource;
    }

    return {
      ...resource,
      calendar: {
        ...(resource.calendar || {}),
        calendarId: assignedShift.shiftId,
        name: `${assignedShift.name} Calendar`,
        workingDays: assignedShift.workingDays || [1, 2, 3, 4, 5],
        workingHoursPerDay: Number(assignedShift.hoursPerDay || 0),
        shifts: [
          {
            shiftId: assignedShift.shiftId,
            name: assignedShift.name,
            startTime: assignedShift.startTime || '00:00',
            endTime: assignedShift.endTime || '23:59',
            breakTime: 0,
            diversions: assignedShift.diversions || []
          }
        ],
        holidays: resource.calendar?.holidays || []
      }
    };
  });
};

/**
 * POST /api/schedule/generate
 * Generate new schedule
 */
router.post('/generate', requirePlanner, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const validation = validate(generateScheduleSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const {
      planningHorizonStartDate,
      planningHorizonEndDate,
      schedulingRule,
      schedulingDirection,
      dateAnchorMode,
      anchorDate,
      selectedJobIds,
      engineType,
      cpSatWeights,
      cpSatTimeLimitSeconds,
      productionMode,
      lineGroupOverrides,
      freezeHorizonDays,
    } = req.body as ScheduleRequest;

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({
        error: 'Database not connected - scheduling unavailable in read-only mode'
      });
    }

    // Load data from Syspro
    const sysproService = new SysproDatabaseService(sysproDb);
    req.log.info('Loading master data from Syspro');

    const [sysproJobs, workcentres, rawResources, materials] = await Promise.all([
      sysproService.getOpenJobs(),
      sysproService.getWorkcentres(),
      sysproService.getResources(),
      sysproService.getInventory()
    ]);
    const resources = applyAssignedShiftCalendars(req.app, rawResources as any);
    const requestedDirection = schedulingDirection === 'backward' ? 'backward' : 'forward';
    const requestedAnchorMode = dateAnchorMode === 'manual' ? 'manual' : 'syspro';
    const parsedAnchorDate = anchorDate ? new Date(anchorDate) : null;
    const hasManualAnchorDate = !!parsedAnchorDate && !Number.isNaN(parsedAnchorDate.getTime());

    let jobs = mergeImportedJobs(req.app, sysproJobs).map((job) => {
      const adjustedJob = {
        ...job,
        dueDate: new Date(job.dueDate),
        releaseDate: new Date(job.releaseDate)
      };

      if (requestedAnchorMode === 'manual' && hasManualAnchorDate) {
        if (requestedDirection === 'backward') {
          adjustedJob.dueDate = new Date(parsedAnchorDate as Date);
        } else {
          adjustedJob.releaseDate = new Date(parsedAnchorDate as Date);
        }
      }

      return adjustedJob;
    });

    // Company scheduling policy: unless jobManagement.includeCompletedOps is
    // enabled, completed operations must not be rescheduled — and jobs with
    // nothing left to do are skipped entirely. (This setting existed in the
    // Settings panel but was never applied until 2026-07-08.)
    let includeCompletedOps = false;
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean; enforceMaterial: boolean } | undefined;
    try {
      const schedulerDb = req.app.locals.schedulerDb;
      const companyId = (req as any).user?.companyId;
      if (schedulerDb && companyId) {
        const cs = await new SettingsService(schedulerDb).getCompanySettings(companyId);
        includeCompletedOps = !!(cs as any)?.jobManagement?.includeCompletedOps;
        const rules = (cs as any)?.fcs?.schedulingRules;
        if (rules) {
          ruleToggles = {
            useQueueTime: rules.useQueueTime !== false,
            useSetupTime: rules.useSetupTime !== false,
            useMoveTime: rules.useMoveTime !== false,
            // When enforceMaterialConstraints is explicitly false, schedule jobs
            // even if their components are short (shortages still surface as
            // warnings in the Constraints tab). Defaults to true.
            enforceMaterial: rules.enforceMaterialConstraints !== false,
          };
        }
      }
    } catch {
      // Settings unavailable — keep the safe defaults (exclude completed ops,
      // all time components enabled).
    }

    if (!includeCompletedOps) {
      const stripped = stripCompletedOperations(jobs);
      jobs = stripped.jobs;
      if (stripped.completedOpsExcluded > 0) {
        req.log.info(
          { completedOpsExcluded: stripped.completedOpsExcluded, jobsExcluded: stripped.jobsExcluded },
          'Excluded completed operations from scheduling run (jobManagement.includeCompletedOps = false)'
        );
      }
    }

    // Filter to selected jobs if the frontend sent a subset.
    // Master/sub families are completed transitively (see utils/jobFamilies).
    if (Array.isArray(selectedJobIds) && selectedJobIds.length > 0) {
      const { idSet, familyAdded } = completeJobFamilies(jobs, selectedJobIds);
      if (familyAdded.length > 0) {
        req.log.info({ familyAdded }, 'Auto-included master/sub family members in scheduling run');
      }

      jobs = jobs.filter((j) => idSet.has(j.jobId));
      req.log.info({ filteredJobs: jobs.length, totalJobs: sysproJobs.length }, 'Filtered to selected jobs');
    }

    req.log.info({ jobs: jobs.length, workcentres: workcentres.length, resources: resources.length }, 'Master data loaded');

    // Create maps for fast lookup
    const workcentreMap = new Map(workcentres.map((wc) => [wc.worcentreId, wc]));
    const resourceMap = new Map(resources.map((r) => [r.resourceId, r]));
    const materialMap = new Map(materials.map((m) => [m.materialId, m]));
    const { resourceCapacities, workcentreCapacities } = buildCapacityMaps(req.app, resources as any);

    // Build per-job material availability once and pass it to the engine.
    // The engine emits one Critical/Warning ConstraintViolation per shortage
    // line and refuses to place jobs that have any uncovered components.
    req.log.info('Building material availability plan');
    let materialPlan: Map<string, any> | undefined;
    try {
      materialPlan = await sysproService.getJobMaterialPlans(jobs as any);
      const shortJobs = Array.from(materialPlan.values()).filter((p: any) => !p.available).length;
      req.log.info({ jobsAnalysed: materialPlan.size, shortJobs }, 'Material plan ready');
    } catch (err) {
      req.log.warn({ err }, 'Material plan failed; continuing without enforcement');
      materialPlan = undefined;
    }

    // Initialize constraint manager
    const constraintManager = new ConstraintManager();
    constraintManager.initializeConstraints(workcentreMap);

    // Load sequence-dependent setup matrix. Primary source is the scheduler DB
    // table from migration 003 (dbo.sch_SetupMatrix — workcentre-aware); falls
    // back to the legacy aps.SetupMatrix for LYNQ-compat installs. Empty array
    // if neither exists — graceful degradation.
    let setupSequences: Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number; workcentreId?: string }> = [];
    try {
      const schedulerDbForMatrix = req.app.locals.schedulerDb;
      if (schedulerDbForMatrix) {
        const smResult = await schedulerDbForMatrix.query(
          `SELECT NULLIF(WorkcentreId, '*') AS workcentreId, FromItemCode AS fromItemCode,
                  ToItemCode AS toItemCode, SetupMinutes AS setupTimeMinutes
           FROM dbo.sch_SetupMatrix`
        );
        setupSequences = smResult.recordset || [];
      }
    } catch {
      req.log.debug('dbo.sch_SetupMatrix not found; trying legacy aps.SetupMatrix');
    }
    if (setupSequences.length === 0) {
      try {
        const smResult = await sysproDb.query(
          `SELECT FromItemCode AS fromItemCode, ToItemCode AS toItemCode, SetupMinutes AS setupTimeMinutes
           FROM aps.SetupMatrix`
        );
        setupSequences = smResult.recordset || [];
      } catch {
        req.log.debug('aps.SetupMatrix not found; sequence-dependent setup times will use operation default');
      }
    }
    if (setupSequences.length > 0) {
      req.log.info({ count: setupSequences.length }, 'Setup matrix loaded');
    }
    // Expand ProductClass-level changeovers into item pairs (prepended so any
    // explicit item-level sch_SetupMatrix row still overrides).
    try {
      const classDerived = await buildClassChangeoverSequences(req.app.locals.schedulerDb, sysproDb, jobs as any, req.log);
      if (classDerived.length) setupSequences = [...classDerived, ...setupSequences];
    } catch (e) { req.log.debug({ err: e }, 'class changeover expansion skipped'); }

    // ── Frozen zone (firm time fence) ────────────────────────────────────
    // Operations from the latest saved schedule that START within the fence
    // keep their exact slot: they are auto-pinned so the engine pre-places
    // them and schedules everything else around them. Manual pins always win.
    const frozenPins = new Map<string, PinnedOperation>();
    const freezeDays = typeof freezeHorizonDays === 'number' && freezeHorizonDays > 0 ? freezeHorizonDays : 0;
    if (freezeDays > 0) {
      try {
        const latest = await sysproDb.query(
          `IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData; ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`
        );
        if (latest.recordset?.length) {
          const saved = JSON.parse(latest.recordset[0].ScheduleData);
          const fenceEnd = new Date(Date.now() + freezeDays * 24 * 60 * 60 * 1000);
          for (const js of saved.jobSchedules || []) {
            for (const os of js.operationSchedules || []) {
              const start = new Date(os.plannedStartDate);
              const end = new Date(os.plannedEndDate);
              if (
                !Number.isNaN(start.getTime()) &&
                !Number.isNaN(end.getTime()) &&
                start <= fenceEnd &&
                os.opStatus !== 'Complete' &&
                os.resourceId
              ) {
                frozenPins.set(`${js.jobId}::${os.opId}`, {
                  jobId: js.jobId,
                  opId: os.opId,
                  workcentreId: os.workcentreId,
                  resourceId: os.resourceId,
                  plannedStartDate: start.toISOString(),
                  plannedEndDate: end.toISOString(),
                  pinnedAt: new Date().toISOString(),
                  pinnedBy: 'frozen-zone',
                });
              }
            }
          }
          req.log.info({ freezeDays, frozenOps: frozenPins.size }, 'Frozen zone applied from latest saved schedule');
        } else {
          req.log.info({ freezeDays }, 'Frozen zone requested but no saved schedule exists — nothing to freeze');
        }
      } catch (err) {
        req.log.warn({ err }, 'Frozen zone requested but latest schedule could not be loaded; continuing without it');
      }
    }

    // Run scheduler in a worker thread so the main thread stays responsive
    req.log.info('Running finite capacity scheduler (worker thread)');

    // Serialize Maps to arrays of entries for transfer to worker
    const workerPayload = {
      jobs,
      workcentres: Array.from(workcentreMap.entries()),
      resources: Array.from(resourceMap.entries()),
      materials: Array.from(materialMap.entries()),
      resourceCapacities: resourceCapacities ? Array.from(resourceCapacities.entries()) : undefined,
      workcentreCapacities: workcentreCapacities ? Array.from(workcentreCapacities.entries()) : undefined,
      materialPlan: materialPlan ? Array.from(materialPlan.entries()) : undefined,
      setupSequences,
      planningHorizonStart: (planningHorizonStartDate || new Date()).toString(),
      planningHorizonEnd: (planningHorizonEndDate || new Date(Date.now() + environment.schedulingHorizonDays * 24 * 60 * 60 * 1000)).toString(),
      schedulingRule: schedulingRule || 'priority',
      schedulingDirection: requestedDirection,
      dateAnchorMode: requestedAnchorMode,
      anchorDate: hasManualAnchorDate ? (parsedAnchorDate as Date).toString() : undefined,
      engineType: engineType || 'greedy',
      cpSatWeights: cpSatWeights,
      cpSatTimeLimitSeconds: cpSatTimeLimitSeconds,
      productionMode: productionMode || 'job-shop',
      lineGroupOverrides: lineGroupOverrides,
      // Company rule toggles (Settings → FCS → Scheduling Rules)
      ruleToggles,
      // Pinned operations — serialised as [key, PinnedOperation][] for the worker.
      // Frozen-zone auto-pins are merged first; manual pins override them.
      pinnedOperations: (() => {
        const merged = new Map<string, any>(frozenPins);
        const pins: Record<string, any> = req.app.locals.pinnedOperations || {};
        for (const [key, pin] of Object.entries(pins)) merged.set(key, pin);
        return merged.size ? Array.from(merged.entries()) : undefined;
      })(),
    };

    const schedule = await runScheduleWorker(workerPayload);

    req.log.info({ scheduledJobs: schedule.jobSchedules.length }, 'Schedule generated');

    // Post-processing: refine material violations with schedule-order awareness (#62).
    // Now that we know planned start dates, re-evaluate material availability with
    // pool depletion in schedule order (earlier jobs consume shared stock first).
    if (materialPlan) {
      try {
        const scheduledOrder: string[] = [...schedule.jobSchedules]
          .sort((a: any, b: any) =>
            new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime()
          )
          .map((js: any) => String(js.jobId));

        const refinedPlan = await sysproService.getJobMaterialPlans(jobs as any, scheduledOrder);

        // Emit new violations only for jobs that are now short due to
        // schedule-order depletion but were OK in the pre-schedule plan.
        // Must be constraintViolations — the engine, UI and counts all read that
        // field; these warnings used to go to an unused 'violations' array.
        schedule.constraintViolations = schedule.constraintViolations ?? [];
        for (const [jobId, plan] of refinedPlan) {
          const originalPlan = materialPlan.get(jobId);
          if (!plan.available && originalPlan?.available === true) {
            for (const shortage of plan.shortages) {
              schedule.constraintViolations.push({
                violationId: uuidv4(),
                type: 'MaterialShortage',
                severity: 'Warning',
                affectedJobId: jobId,
                description:
                  `Schedule-order depletion: ${shortage.componentCode} ` +
                  `(need ${shortage.requiredQty.toFixed(2)}, ` +
                  `available ${shortage.availableQty.toFixed(2)} after earlier jobs)`,
              });
            }
          }
        }
        req.log.info('Schedule-order material refinement complete');
      } catch (err) {
        req.log.warn({ err }, 'Schedule-order material refinement failed; continuing');
      }
    }

    // Auto-save to DB so the schedule survives page reloads (atomic — see ScheduleStore).
    try {
      const { jobCount } = await saveAsLatest(sysproDb, schedule, { status: 'Draft', generatedAt: new Date() });
      req.log.info({ jobCount }, 'Schedule auto-saved to DB');
    } catch (saveErr) {
      req.log.warn({ err: saveErr }, 'Could not auto-save schedule to DB (non-blocking)');
    }

    res.json({
      schedule,
      executionTimeMs: Date.now() - startedAt,
      warningCount: schedule.constraintViolations.filter((c: any) => c.severity === 'Warning').length,
      errorCount: schedule.constraintViolations.filter((c: any) => c.severity === 'Critical').length
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error generating schedule');
    res.status(500).json({ error: (error as any).message || 'Failed to generate schedule' });
  }
});

/**
 * POST /api/schedule/optimize
 *
 * Sequencing optimizer: runs the finite-capacity engine over the SAME jobs
 * under each candidate dispatching rule, then ranks the outcomes so the planner
 * can pick the best strategy (the "optimization" feature of PlanetTogether /
 * Opcenter APS). Read-only — nothing is saved; the live schedule is untouched.
 */
router.post('/optimize', requirePlanner, async (req: Request, res: Response) => {
  const validation = validate(optimizeScheduleSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const {
      rules,
      objective,
      planningHorizonStartDate,
      planningHorizonEndDate,
      schedulingDirection,
      dateAnchorMode,
      anchorDate,
      selectedJobIds,
      productionMode,
      lineGroupOverrides,
    } = req.body as any;

    const candidateRules: SchedulingRule[] =
      Array.isArray(rules) && rules.length ? rules : ALL_RULES;

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected — optimization unavailable' });
    }

    // ── Load master data once (shared across all rule runs) ──────────────────
    const sysproService = new SysproDatabaseService(sysproDb);
    const [sysproJobs, workcentres, rawResources, materials] = await Promise.all([
      sysproService.getOpenJobs(),
      sysproService.getWorkcentres(),
      sysproService.getResources(),
      sysproService.getInventory(),
    ]);
    const resources = applyAssignedShiftCalendars(req.app, rawResources as any);
    const requestedDirection = schedulingDirection === 'backward' ? 'backward' : 'forward';
    const requestedAnchorMode = dateAnchorMode === 'manual' ? 'manual' : 'syspro';
    const parsedAnchorDate = anchorDate ? new Date(anchorDate) : null;
    const hasManualAnchorDate = !!parsedAnchorDate && !Number.isNaN(parsedAnchorDate.getTime());

    let jobs = mergeImportedJobs(req.app, sysproJobs).map((job) => {
      const adjustedJob = { ...job, dueDate: new Date(job.dueDate), releaseDate: new Date(job.releaseDate) };
      if (requestedAnchorMode === 'manual' && hasManualAnchorDate) {
        if (requestedDirection === 'backward') adjustedJob.dueDate = new Date(parsedAnchorDate as Date);
        else adjustedJob.releaseDate = new Date(parsedAnchorDate as Date);
      }
      return adjustedJob;
    });

    // Same completed-op / rule-toggle policy as /generate for a fair comparison.
    let includeCompletedOps = false;
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean } | undefined;
    try {
      const schedulerDb = req.app.locals.schedulerDb;
      const companyId = (req as any).user?.companyId;
      if (schedulerDb && companyId) {
        const cs = await new SettingsService(schedulerDb).getCompanySettings(companyId);
        includeCompletedOps = !!(cs as any)?.jobManagement?.includeCompletedOps;
        const rulesCfg = (cs as any)?.fcs?.schedulingRules;
        if (rulesCfg) {
          ruleToggles = {
            useQueueTime: rulesCfg.useQueueTime !== false,
            useSetupTime: rulesCfg.useSetupTime !== false,
            useMoveTime: rulesCfg.useMoveTime !== false,
          };
        }
      }
    } catch { /* safe defaults */ }

    if (!includeCompletedOps) {
      jobs = stripCompletedOperations(jobs).jobs;
    }

    if (Array.isArray(selectedJobIds) && selectedJobIds.length > 0) {
      const { idSet } = completeJobFamilies(jobs, selectedJobIds);
      jobs = jobs.filter((j) => idSet.has(j.jobId));
    }

    if (jobs.length === 0) {
      return res.status(400).json({ error: 'No jobs to schedule — nothing to optimize' });
    }

    const workcentreMap = new Map(workcentres.map((wc) => [wc.worcentreId, wc]));
    const resourceMap = new Map(resources.map((r) => [r.resourceId, r]));
    const materialMap = new Map(materials.map((m) => [m.materialId, m]));
    const { resourceCapacities, workcentreCapacities } = buildCapacityMaps(req.app, resources as any);

    let materialPlan: Map<string, any> | undefined;
    try {
      materialPlan = await sysproService.getJobMaterialPlans(jobs as any);
    } catch {
      materialPlan = undefined;
    }

    // Setup matrix (same precedence as /generate).
    let setupSequences: Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number; workcentreId?: string }> = [];
    try {
      const schedulerDbForMatrix = req.app.locals.schedulerDb;
      if (schedulerDbForMatrix) {
        const smResult = await schedulerDbForMatrix.query(
          `SELECT NULLIF(WorkcentreId, '*') AS workcentreId, FromItemCode AS fromItemCode,
                  ToItemCode AS toItemCode, SetupMinutes AS setupTimeMinutes
           FROM dbo.sch_SetupMatrix`
        );
        setupSequences = smResult.recordset || [];
      }
    } catch { /* optional */ }
    try {
      const classDerived = await buildClassChangeoverSequences(req.app.locals.schedulerDb, sysproDb, jobs as any, req.log);
      if (classDerived.length) setupSequences = [...classDerived, ...setupSequences];
    } catch (e) { req.log.debug({ err: e }, 'class changeover expansion skipped'); }

    const basePayload = {
      workcentres: Array.from(workcentreMap.entries()),
      resources: Array.from(resourceMap.entries()),
      materials: Array.from(materialMap.entries()),
      resourceCapacities: resourceCapacities ? Array.from(resourceCapacities.entries()) : undefined,
      workcentreCapacities: workcentreCapacities ? Array.from(workcentreCapacities.entries()) : undefined,
      materialPlan: materialPlan ? Array.from(materialPlan.entries()) : undefined,
      setupSequences,
      planningHorizonStart: (planningHorizonStartDate || new Date()).toString(),
      planningHorizonEnd: (planningHorizonEndDate || new Date(Date.now() + environment.schedulingHorizonDays * 24 * 60 * 60 * 1000)).toString(),
      schedulingDirection: requestedDirection,
      dateAnchorMode: requestedAnchorMode,
      anchorDate: hasManualAnchorDate ? (parsedAnchorDate as Date).toString() : undefined,
      engineType: 'greedy' as const,
      productionMode: productionMode || 'job-shop',
      lineGroupOverrides,
      ruleToggles,
    };

    const runWorker = (schedulingRule: SchedulingRule) =>
      runScheduleWorker({ ...basePayload, jobs, schedulingRule });

    // Run rules sequentially — worker threads are CPU-bound; parallel spawn would
    // just contend for the same cores and muddy the comparison.
    const runResults: RuleResult[] = [];
    for (const rule of candidateRules) {
      try {
        const schedule = await runWorker(rule);
        runResults.push({ rule, metrics: schedule.metrics as any });
      } catch (err) {
        req.log.warn({ err, rule }, 'Rule run failed during optimization');
        runResults.push({
          rule,
          metrics: {
            totalJobsScheduled: 0, jobsOnTime: 0, jobsTardy: 0, averageTardiness: 0,
            resourceUtilization: 0, overtimeHours: 0, criticalPathLength: 0, totalSetupTime: 0,
          },
          error: (err as any).message || 'Run failed',
        });
      }
    }

    const ranked = rankRuleResults(runResults, objective || 'balanced');
    const recommended = ranked.find((r) => r.recommended) || null;

    res.json({
      objective: objective || 'balanced',
      jobsConsidered: jobs.length,
      recommendedRule: recommended?.rule || null,
      results: ranked.map((r) => ({ ...r, label: RULE_LABELS[r.rule] })),
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error running sequencing optimization');
    res.status(500).json({ error: (error as any).message || 'Failed to optimize' });
  }
});

/**
 * GET /api/schedule/latest
 * Load the most recently saved schedule from DB
 */
router.get('/latest', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await sysproDb.query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS int) AS x;
      ELSE
      SELECT TOP 1 ScheduleID, ScheduleData, Status, JobCount, OperationCount,
        HorizonStart, HorizonEnd, GeneratedAt, SavedAt
      FROM aps.SavedSchedules
      WHERE IsLatest = 1
      ORDER BY SavedAt DESC
    `);

    if (!result.recordset || result.recordset.length === 0) {
      return res.json({ schedule: null });
    }

    const row = result.recordset[0];
    const schedule = JSON.parse(row.ScheduleData);

    res.json({
      schedule,
      meta: {
        scheduleId: row.ScheduleID,
        status: row.Status,
        jobCount: row.JobCount,
        operationCount: row.OperationCount,
        horizonStart: row.HorizonStart,
        horizonEnd: row.HorizonEnd,
        generatedAt: row.GeneratedAt,
        savedAt: row.SavedAt
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading latest schedule');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/save
 * Persist a schedule to DB (marks all others as not-latest)
 */
router.post('/save', requirePlanner, async (req: Request, res: Response) => {
  const validation = validate(saveScheduleSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const { schedule } = req.body as { schedule: any };

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    // Any saved change is a new Draft: an edit made after approval must be
    // approved again before it can be sent to SYSPRO. Atomic — see ScheduleStore.
    const { jobCount, operationCount } = await saveAsLatest(sysproDb, schedule, { status: 'Draft' });

    req.log.info({ scheduleId: schedule.scheduleId, jobCount, operationCount }, 'Schedule saved');
    res.json({ saved: true, scheduleId: schedule.scheduleId });
  } catch (error) {
    req.log.error({ err: error }, 'Error saving schedule');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/load-version/:scheduleId
 * Restore a saved schedule version as the active (latest) schedule.
 * Promotes the chosen version to IsLatest=1 and records a structured audit entry.
 */
router.post('/load-version/:scheduleId', requirePlanner, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await sysproDb.queryWithParams(
      `SELECT ScheduleData, GeneratedAt FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );

    if (!result.recordset || result.recordset.length === 0) {
      return res.status(404).json({ error: 'Schedule version not found' });
    }

    const schedule = JSON.parse(result.recordset[0].ScheduleData);
    const restoredAt = new Date().toISOString();

    // Promote this version as the new latest (demote all others) — atomically.
    await promoteToLatest(sysproDb, scheduleId);

    req.log.info({ scheduleId, restoredAt }, 'version_restore');

    res.json({ schedule, restoredAt });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/pins
 * Return all currently pinned operations.
 * (Registered before /:scheduleId — a later registration would be shadowed
 * by the param route and always 404.)
 */
router.get('/pins', (req: Request, res: Response) => {
  const pins: Record<string, PinnedOperation> = req.app.locals.pinnedOperations || {};
  return res.json(Object.values(pins));
});

// ═══════════════ Setup matrix (sequence-dependent changeovers) ═══════════════
// NOTE: these static routes MUST be registered before GET /:scheduleId below,
// otherwise Express would treat "setup-matrix" as a scheduleId.

/**
 * GET /api/schedule/setup-matrix
 * List all changeover rows (workcentre, from item, to item, minutes).
 */
router.get('/setup-matrix', async (req: Request, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const result = await schedulerDb.query(
      `SELECT SetupId AS setupId, WorkcentreId AS workcentreId, FromItemCode AS fromItemCode,
              ToItemCode AS toItemCode, SetupMinutes AS setupMinutes, UpdatedAt AS updatedAt
       FROM dbo.sch_SetupMatrix
       ORDER BY WorkcentreId, FromItemCode, ToItemCode`
    );
    res.json({ rows: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading setup matrix');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/setup-matrix
 * Upsert one changeover row (unique on workcentre + from + to).
 */
router.post('/setup-matrix', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupMatrixRowSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const { workcentreId, fromItemCode, toItemCode, setupMinutes } = validation.data;

    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_SetupMatrix AS target
       USING (SELECT @workcentreId AS WorkcentreId, @fromItemCode AS FromItemCode, @toItemCode AS ToItemCode) AS src
         ON target.WorkcentreId = src.WorkcentreId
        AND target.FromItemCode = src.FromItemCode
        AND target.ToItemCode = src.ToItemCode
       WHEN MATCHED THEN
         UPDATE SET SetupMinutes = @setupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (WorkcentreId, FromItemCode, ToItemCode, SetupMinutes)
         VALUES (@workcentreId, @fromItemCode, @toItemCode, @setupMinutes);`,
      { workcentreId, fromItemCode, toItemCode, setupMinutes }
    );

    req.log.info({ workcentreId, fromItemCode, toItemCode, setupMinutes }, 'Setup matrix row upserted');
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'Error upserting setup matrix row');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * DELETE /api/schedule/setup-matrix/:setupId
 */
router.delete('/setup-matrix/:setupId', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    await schedulerDb.queryWithParams(
      `DELETE FROM dbo.sch_SetupMatrix WHERE SetupId = @setupId`,
      { setupId: req.params.setupId }
    );
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'Error deleting setup matrix row');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * Expand the ProductClass-level changeover matrix into item->item setup times
 * for the items in this run, using each item's InvMaster.ProductClass. Lets the
 * (item-keyed) scheduler charge class-level changeovers with no engine change.
 */
async function buildClassChangeoverSequences(
  schedulerDb: any,
  sysproDb: any,
  jobs: Array<{ itemCode?: string }>,
  log: any
): Promise<Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number }>> {
  if (!schedulerDb) return [];
  let classRows: Array<{ fromClass: string; toClass: string; setupMinutes: number }> = [];
  try {
    const r = await schedulerDb.query(
      `IF OBJECT_ID('dbo.sch_ClassChangeover', 'U') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS fromClass, CAST('' AS nvarchar(50)) AS toClass, CAST(0 AS int) AS setupMinutes;
       ELSE
         SELECT FromClass AS fromClass, ToClass AS toClass, SetupMinutes AS setupMinutes
         FROM dbo.sch_ClassChangeover WHERE SetupMinutes > 0`
    );
    classRows = r.recordset || [];
  } catch {
    return [];
  }
  if (classRows.length === 0) return [];
  const items = Array.from(
    new Set(jobs.map((j) => String(j.itemCode || '').toUpperCase().trim()).filter(Boolean))
  );
  if (items.length === 0 || !sysproDb) return [];
  const itemClass = new Map<string, string>();
  try {
    const r = await sysproDb.queryWithParams(
      `IF OBJECT_ID('InvMaster', 'U') IS NULL OR COL_LENGTH('InvMaster', 'ProductClass') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS StockCode, CAST('' AS nvarchar(50)) AS ProductClass;
       ELSE
         SELECT m.StockCode AS StockCode, ISNULL(m.ProductClass, '') AS ProductClass
         FROM InvMaster m
         JOIN OPENJSON(@items) WITH (code nvarchar(50) '$') j ON j.code = m.StockCode`,
      { items: JSON.stringify(items) }
    );
    for (const row of r.recordset || []) {
      itemClass.set(String(row.StockCode).toUpperCase(), String(row.ProductClass || '').toUpperCase().trim());
    }
  } catch {
    return [];
  }
  const cm = new Map<string, number>();
  for (const cr of classRows) {
    cm.set(`${String(cr.fromClass).toUpperCase().trim()}->${String(cr.toClass).toUpperCase().trim()}`, cr.setupMinutes);
  }
  const out: Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number }> = [];
  for (const a of items) {
    const ca = itemClass.get(a);
    if (!ca) continue;
    for (const b of items) {
      if (a === b) continue;
      const cb = itemClass.get(b);
      if (!cb) continue;
      const mins = cm.get(`${ca}->${cb}`);
      if (mins && mins > 0) out.push({ fromItemCode: a, toItemCode: b, setupTimeMinutes: mins });
    }
  }
  if (out.length && log) log.info({ pairs: out.length, classes: classRows.length }, 'Class-level changeovers expanded');
  return out;
}

/**
 * POST /api/schedule/setup-matrix/bulk
 * Upsert many changeover cells at once (Changeover Matrix grid save). A cell
 * with setupMinutes = 0 is deleted so the matrix stays sparse. Global rows use
 * WorkcentreId '*' (see setupMatrixRowSchema default).
 */
router.post('/setup-matrix/bulk', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupMatrixBulkSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const rows = validation.data.rows.map((r) => ({
      workcentreId: (r.workcentreId || '*').toUpperCase() === 'ALL' ? '*' : (r.workcentreId || '*'),
      fromItemCode: r.fromItemCode.trim().toUpperCase(),
      toItemCode: r.toItemCode.trim().toUpperCase(),
      setupMinutes: Math.round(r.setupMinutes),
    })).filter((r) => r.fromItemCode !== r.toItemCode);
    if (rows.length === 0) return res.json({ ok: true, applied: 0 });

    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_SetupMatrix AS target
       USING (
         SELECT WorkcentreId, FromItemCode, ToItemCode, SetupMinutes
         FROM OPENJSON(@rows) WITH (
           WorkcentreId nvarchar(50) '$.workcentreId',
           FromItemCode nvarchar(50) '$.fromItemCode',
           ToItemCode   nvarchar(50) '$.toItemCode',
           SetupMinutes int          '$.setupMinutes'
         )
       ) AS src
         ON target.WorkcentreId = src.WorkcentreId
        AND target.FromItemCode = src.FromItemCode
        AND target.ToItemCode  = src.ToItemCode
       WHEN MATCHED AND src.SetupMinutes > 0 THEN
         UPDATE SET SetupMinutes = src.SetupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN MATCHED AND src.SetupMinutes <= 0 THEN
         DELETE
       WHEN NOT MATCHED BY TARGET AND src.SetupMinutes > 0 THEN
         INSERT (WorkcentreId, FromItemCode, ToItemCode, SetupMinutes)
         VALUES (src.WorkcentreId, src.FromItemCode, src.ToItemCode, src.SetupMinutes);`,
      { rows: JSON.stringify(rows) }
    );
    req.log.info({ count: rows.length }, 'Setup matrix bulk-upserted');
    res.json({ ok: true, applied: rows.length });
  } catch (error) {
    req.log.error({ err: error }, 'Error bulk-saving setup matrix');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/finished-goods?q=
 * Finished (manufactured) goods from SYSPRO InvMaster for the Changeover Matrix
 * axes. Schema-defensive: filters PartCategory = 'M' (this install's finished-goods
 * discriminator) when that column exists, else returns all stock codes.
 * Optional ?q= narrows by code/description.
 */
router.get('/finished-goods', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const q = String(req.query.q || '').trim();
    const sql = `
      IF OBJECT_ID('InvMaster', 'U') IS NULL
        SELECT TOP 0 CAST('' AS varchar(50)) AS stockCode, CAST('' AS varchar(200)) AS description;
      ELSE
      BEGIN
        DECLARE @descExpr NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'ISNULL(m.Description, '''')'
          ELSE N'CAST('''' AS nvarchar(200))' END;
        DECLARE @fgFilter NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'PartCategory') IS NOT NULL THEN N'm.PartCategory = ''M'''
          ELSE N'1 = 1' END;
        DECLARE @qFilter NVARCHAR(500) = CASE WHEN LEN(@q) > 0 THEN (CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N' AND (m.StockCode LIKE @q OR m.Description LIKE @q)'
          ELSE N' AND m.StockCode LIKE @q' END) ELSE N'' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT TOP 10000 m.StockCode AS stockCode, ' + @descExpr + N' AS description
          FROM InvMaster m
          WHERE ' + @fgFilter + @qFilter + N'
          ORDER BY m.StockCode';
        EXEC sp_executesql @sql, N'@q NVARCHAR(200)', @q = @q;
      END`;
    const result = await sysproDb.queryWithParams(sql, { q: `%${q}%` });
    res.json({ items: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading finished goods');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/product-classes
 * Distinct SYSPRO product classes (InvMaster.ProductClass) among finished
 * (PartCategory='M') goods — the axes of the class-level Changeover Matrix.
 */
router.get('/product-classes', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const sql = `
      SET NOCOUNT ON;
      IF OBJECT_ID('InvMaster', 'U') IS NULL OR COL_LENGTH('InvMaster', 'ProductClass') IS NULL
        SELECT TOP 0 CAST('' AS nvarchar(50)) AS productClass, CAST(1 AS bit) AS filtered;
      ELSE
      BEGIN
        -- Finished-goods discriminator: on this SYSPRO install manufactured
        -- finished goods are identified by PartCategory = 'M' (verified 2026-09;
        -- NOT MakeBuyCode). Applied only when the column is present.
        DECLARE @fg NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'PartCategory') IS NOT NULL THEN N'm.PartCategory = ''M'''
          ELSE N'1 = 1' END;
        DECLARE @base NVARCHAR(300) = N' FROM InvMaster m WHERE LTRIM(RTRIM(ISNULL(m.ProductClass, ''''))) <> '''' ';
        CREATE TABLE #pc (productClass nvarchar(200), filtered bit);
        -- 1) Manufactured finished goods that carry a ProductClass.
        DECLARE @sql NVARCHAR(MAX) = N'SELECT DISTINCT LTRIM(RTRIM(m.ProductClass)), CAST(1 AS bit)' + @base + N'AND (' + @fg + N')';
        INSERT INTO #pc (productClass, filtered) EXEC sp_executesql @sql;
        -- 2) Fallback: if no manufactured item carries a ProductClass, surface every
        --    product class so the changeover matrix is still usable rather than empty.
        IF NOT EXISTS (SELECT 1 FROM #pc)
        BEGIN
          DECLARE @sql2 NVARCHAR(MAX) = N'SELECT DISTINCT LTRIM(RTRIM(m.ProductClass)), CAST(0 AS bit)' + @base;
          INSERT INTO #pc (productClass, filtered) EXEC sp_executesql @sql2;
        END
        SELECT productClass, filtered FROM #pc ORDER BY productClass;
        DROP TABLE #pc;
      END`;
    const result = await sysproDb.query(sql);
    const rows = (result.recordset || []) as Array<{ productClass: string; filtered: boolean }>;
    const usedFilter = rows.length === 0 || rows[0].filtered !== false;
    const body: { classes: string[]; warning?: string } = {
      classes: rows.map((r) => r.productClass),
    };
    if (!usedFilter) {
      body.warning =
        'No finished goods (PartCategory = M) carry a ProductClass, so all product ' +
        'classes are shown. Assign ProductClass to your finished goods in SYSPRO to ' +
        'refine the changeover axes.';
    }
    res.json(body);
  } catch (error) {
    req.log.error({ err: error }, 'Error loading product classes');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/class-changeover — current ProductClass->ProductClass values.
 */
router.get('/class-changeover', async (req: Request, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const result = await schedulerDb.query(
      `IF OBJECT_ID('dbo.sch_ClassChangeover', 'U') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS fromClass, CAST('' AS nvarchar(50)) AS toClass, CAST(0 AS int) AS setupMinutes;
       ELSE
         SELECT FromClass AS fromClass, ToClass AS toClass, SetupMinutes AS setupMinutes
         FROM dbo.sch_ClassChangeover ORDER BY FromClass, ToClass`
    );
    res.json({ rows: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading class changeover matrix');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/class-changeover/bulk — upsert/delete class->class cells.
 * setupMinutes = 0 deletes the cell (sparse). Charged during scheduling by
 * expanding to item pairs via each item's ProductClass.
 */
router.post('/class-changeover/bulk', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupClassBulkSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const rows = validation.data.rows.map((r) => ({
      fromClass: r.fromClass.trim().toUpperCase(),
      toClass: r.toClass.trim().toUpperCase(),
      setupMinutes: Math.round(r.setupMinutes),
    })).filter((r) => r.fromClass !== r.toClass);
    if (rows.length === 0) return res.json({ ok: true, applied: 0 });
    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_ClassChangeover AS target
       USING (
         SELECT FromClass, ToClass, SetupMinutes
         FROM OPENJSON(@rows) WITH (
           FromClass    nvarchar(50) '$.fromClass',
           ToClass      nvarchar(50) '$.toClass',
           SetupMinutes int          '$.setupMinutes'
         )
       ) AS src
         ON target.FromClass = src.FromClass AND target.ToClass = src.ToClass
       WHEN MATCHED AND src.SetupMinutes > 0 THEN
         UPDATE SET SetupMinutes = src.SetupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN MATCHED AND src.SetupMinutes <= 0 THEN
         DELETE
       WHEN NOT MATCHED BY TARGET AND src.SetupMinutes > 0 THEN
         INSERT (FromClass, ToClass, SetupMinutes)
         VALUES (src.FromClass, src.ToClass, src.SetupMinutes);`,
      { rows: JSON.stringify(rows) }
    );
    req.log.info({ count: rows.length }, 'Class changeover bulk-upserted');
    res.json({ ok: true, applied: rows.length });
  } catch (error) {
    req.log.error({ err: error }, 'Error bulk-saving class changeover');
    res.status(500).json({ error: (error as any).message });
  }
});

// ═══════════════════ Capable-to-Promise (order promising) ════════════════════

/**
 * POST /api/schedule/ctp
 * Simulate inserting a prospective order's routing into the current committed
 * load and return the earliest promisable completion date. Read-only — the
 * live schedule is never modified.
 */
router.post('/ctp', async (req: Request, res: Response) => {
  const validation = validate(ctpRequestSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

    // Resources (with assigned shift calendars, same as /generate).
    const sysproService = new SysproDatabaseService(sysproDb);
    const rawResources = await sysproService.getResources();
    const resources = applyAssignedShiftCalendars(req.app, rawResources as any);

    // Committed load = busy intervals from the latest saved schedule.
    const busyByResource = new Map<string, { start: number; end: number }[]>();
    try {
      const latest = await sysproDb.query(
        `IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData; ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`
      );
      if (latest.recordset?.length) {
        const saved = JSON.parse(latest.recordset[0].ScheduleData);
        for (const js of saved.jobSchedules || []) {
          for (const os of js.operationSchedules || []) {
            const start = new Date(os.plannedStartDate).getTime();
            const end = new Date(os.plannedEndDate).getTime();
            if (!os.resourceId || Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
            if (!busyByResource.has(os.resourceId)) busyByResource.set(os.resourceId, []);
            busyByResource.get(os.resourceId)!.push({ start, end });
          }
        }
      }
    } catch {
      // No saved schedule — computeCtp records the assumption.
    }

    const { operations, subJobs, desiredDueDate, earliestStart } = validation.data;
    const mapOps = (ops: Array<{ workcentreId: string; setupMinutes?: number; runMinutes: number; description?: string }>) =>
      ops.map((op) => ({
        workcentreId: op.workcentreId,
        setupMinutes: op.setupMinutes ?? 0,
        runMinutes: op.runMinutes,
        description: op.description,
      }));
    const result = computeCtp({
      operations: mapOps(operations),
      subRoutings: subJobs?.length
        ? subJobs.map((sj) => ({ label: sj.label, operations: mapOps(sj.operations) }))
        : undefined,
      resources: resources as any,
      busyByResource,
      earliestStart: earliestStart ? new Date(earliestStart) : new Date(),
      desiredDueDate: desiredDueDate ? new Date(desiredDueDate) : undefined,
    });

    req.log.info(
      { feasible: result.feasible, promiseDate: result.promiseDate, ops: operations.length },
      'CTP simulation complete'
    );
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'Error running CTP simulation');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/ctp/stock-search?q=
 * Search InvMaster stock codes for the Promise tab picker.
 */
router.get('/ctp/stock-search', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });

    // Schema-defensive: SYSPRO installs vary. Guard InvMaster.Description and the
    // BomOperations table (hasRouting) so a missing column/table degrades instead
    // of throwing. Any genuinely unexpected SQL error still surfaces to the toast.
    const searchSql = `
      IF OBJECT_ID('InvMaster', 'U') IS NULL
        SELECT TOP 0 CAST('' AS varchar(50)) AS stockCode,
                     CAST('' AS varchar(200)) AS description,
                     CAST(0 AS int) AS hasRouting;
      ELSE
      BEGIN
        DECLARE @descExpr NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'ISNULL(m.Description, '''')'
          ELSE N'CAST('''' AS nvarchar(200))' END;
        DECLARE @routingExpr NVARCHAR(400) = CASE
          WHEN OBJECT_ID('BomOperations', 'U') IS NOT NULL
            THEN N'CASE WHEN EXISTS (SELECT 1 FROM BomOperations bo WHERE bo.StockCode = m.StockCode) THEN 1 ELSE 0 END'
          ELSE N'CAST(0 AS int)' END;
        DECLARE @whereExpr NVARCHAR(400) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'm.StockCode LIKE @q OR m.Description LIKE @q'
          ELSE N'm.StockCode LIKE @q' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT TOP 25 m.StockCode AS stockCode, ' + @descExpr + N' AS description,
                 ' + @routingExpr + N' AS hasRouting
          FROM InvMaster m
          WHERE ' + @whereExpr + N'
          ORDER BY ' + @routingExpr + N' DESC, m.StockCode';
        EXEC sp_executesql @sql, N'@q NVARCHAR(200)', @q = @q;
      END`;
    const result = await sysproDb.queryWithParams(searchSql, { q: `%${q}%` });
    res.json({ items: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error searching stock codes');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/ctp/stock-routing/:stockCode?quantity=n
 *
 * Build a CTP request skeleton from SYSPRO structures & routings — NOT from
 * open WIP jobs: the routing comes from BomOperations (first route) and each
 * made-in BomStructure component that has its own routing becomes a sub-job
 * leg (scaled by QtyPer × quantity). SYSPRO times are hours → minutes here.
 */
router.get('/ctp/stock-routing/:stockCode', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const stockCode = String(req.params.stockCode || '').trim();
    if (!stockCode) return res.status(400).json({ error: 'stockCode is required' });
    const quantity = Math.max(1, Number(req.query.quantity) || 1);
    const warnings: string[] = [];

    // Column names vary across SYSPRO versions — resolve them defensively,
    // matching the COL_LENGTH pattern used elsewhere in this codebase.
    const routingSql = `
      IF OBJECT_ID('BomOperations', 'U') IS NULL
        SELECT TOP 0 CAST('' AS nvarchar(50)) AS operation,
                     CAST('' AS nvarchar(50)) AS workcentreId,
                     CAST(0 AS float) AS setupHours,
                     CAST(0 AS float) AS unitRunHours;
      ELSE
      BEGIN
        DECLARE @setupExpr NVARCHAR(100) = CASE
          WHEN COL_LENGTH('BomOperations', 'SetUpTime') IS NOT NULL THEN N'ISNULL(bo.SetUpTime, 0)'
          WHEN COL_LENGTH('BomOperations', 'SetupTime') IS NOT NULL THEN N'ISNULL(bo.SetupTime, 0)'
          ELSE N'CAST(0 AS float)' END;
        DECLARE @runExpr NVARCHAR(100) = CASE
          WHEN COL_LENGTH('BomOperations', 'UnitRunTime') IS NOT NULL THEN N'ISNULL(bo.UnitRunTime, 0)'
          WHEN COL_LENGTH('BomOperations', 'RunTime') IS NOT NULL THEN N'ISNULL(bo.RunTime, 0)'
          ELSE N'CAST(0 AS float)' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT bo.Operation AS operation, bo.WorkCentre AS workcentreId,
                 ' + @setupExpr + N' AS setupHours,
                 ' + @runExpr + N' AS unitRunHours
          FROM BomOperations bo
          WHERE bo.StockCode = @sc
            AND bo.Route = (SELECT MIN(Route) FROM BomOperations WHERE StockCode = @sc)
          ORDER BY TRY_CAST(bo.Operation AS int), bo.Operation';
        EXEC sp_executesql @sql, N'@sc NVARCHAR(50)', @sc = @stockCode;
      END
    `;

    const buildOps = (rows: any[], qty: number) =>
      (rows || []).map((r: any) => ({
        workcentreId: String(r.workcentreId || '').trim(),
        setupMinutes: Math.round((Number(r.setupHours) || 0) * 60),
        runMinutes: Math.max(1, Math.round((Number(r.unitRunHours) || 0) * 60 * qty)),
        description: `Op ${String(r.operation ?? '').trim()}`,
      })).filter((op: any) => op.workcentreId);

    const routingResult = await sysproDb.queryWithParams(routingSql, { stockCode });
    const operations = buildOps(routingResult.recordset, quantity);
    if (operations.length === 0) {
      return res.status(404).json({ error: `No routing found in BomOperations for stock code ${stockCode}` });
    }

    // Made-in components — FULL multi-level BomStructure explosion.
    // SYSPRO 8 keys the parent as BomStructure.StockCode (child = Component);
    // some installs/older schemas use ParentPart. Resolve dynamically.
    //
    // Model: each DIRECT child of the quoted item becomes one CTP leg; deeper
    // made-in descendants are serialised INTO their branch's leg in build
    // order (children before parents). Branches run in parallel sharing
    // capacity; the master routing starts after the last branch — matching
    // CtpService's leg semantics. Within a branch this respects precedence
    // exactly for chains and is conservative (never optimistic) when a branch
    // itself has parallel children. Children are traversed even when they have
    // no routing of their own (phantoms), so deeper made-in levels are found.
    const subJobs: Array<{ label: string; operations: any[] }> = [];
    try {
      const structureSql = `
        IF OBJECT_ID('BomStructure', 'U') IS NULL
          SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer;
        ELSE
        BEGIN
          DECLARE @parentCol NVARCHAR(30) = CASE
            WHEN COL_LENGTH('BomStructure', 'ParentPart') IS NOT NULL THEN N'ParentPart'
            WHEN COL_LENGTH('BomStructure', 'StockCode') IS NOT NULL THEN N'StockCode'
            ELSE NULL END;
          IF @parentCol IS NULL
            SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer;
          ELSE
          BEGIN
            DECLARE @qtyExpr NVARCHAR(60) = CASE
              WHEN COL_LENGTH('BomStructure', 'QtyPer') IS NOT NULL THEN N'ISNULL(bs.QtyPer, 1)'
              ELSE N'CAST(1 AS float)' END;
            -- Keep components that are made-in (have a routing) OR are
            -- structural (have children of their own, e.g. phantoms) so the
            -- traversal can reach deeper made-in levels. Purchased leaf parts
            -- (no routing, no children) are excluded.
            DECLARE @sqlStr NVARCHAR(MAX) = N'
              SELECT DISTINCT bs.Component AS component, ' + @qtyExpr + N' AS qtyPer
              FROM BomStructure bs
              WHERE bs.' + @parentCol + N' = @sc
                AND (
                  EXISTS (SELECT 1 FROM BomOperations bo WHERE bo.StockCode = bs.Component)
                  OR EXISTS (SELECT 1 FROM BomStructure b2 WHERE b2.' + @parentCol + N' = bs.Component)
                )
              ORDER BY bs.Component';
            EXEC sp_executesql @sqlStr, N'@sc NVARCHAR(50)', @sc = @sc;
          END
        END`;

      const MAX_DEPTH = 10;
      const MAX_NODES = 200;
      let nodesVisited = 0;
      let multiLevel = false;

      const getChildren = async (parent: string): Promise<Array<{ component: string; qtyPer: number }>> => {
        const r = await sysproDb.queryWithParams(structureSql, { sc: parent });
        return (r.recordset || []) as Array<{ component: string; qtyPer: number }>;
      };

      /**
       * Post-order (build-order) explosion of one branch: descendants' ops are
       * appended before the node's own ops. Quantities compound down the chain
       * (QtyPer × parent qty). Cycle-safe via the ancestor set.
       */
      const explodeBranch = async (
        code: string,
        qty: number,
        depth: number,
        ancestors: Set<string>,
        acc: any[]
      ): Promise<void> => {
        if (depth > MAX_DEPTH) {
          warnings.push(`BOM deeper than ${MAX_DEPTH} levels under ${code} — deeper levels omitted.`);
          return;
        }
        if (ancestors.has(code)) {
          warnings.push(`Circular BOM reference at ${code} — branch skipped.`);
          return;
        }
        if (++nodesVisited > MAX_NODES) return;
        ancestors.add(code);
        for (const child of await getChildren(code)) {
          const childCode = String(child.component).trim();
          const childQty = Math.max(1, Math.ceil((Number(child.qtyPer) || 1) * qty));
          await explodeBranch(childCode, childQty, depth + 1, ancestors, acc);
        }
        const routing = await sysproDb.queryWithParams(routingSql, { stockCode: code });
        const ownOps = buildOps(routing.recordset, qty).map((op: any) => ({
          ...op,
          description: `${code} · ${op.description}`,
        }));
        if (ownOps.length && depth > 1) multiLevel = true;
        acc.push(...ownOps);
        ancestors.delete(code);
      };

      for (const comp of await getChildren(stockCode)) {
        if (subJobs.length >= 20) {
          warnings.push('More than 20 made-in sub-assembly branches — extra branches omitted.');
          break;
        }
        const compCode = String(comp.component).trim();
        const compQty = Math.max(1, Math.ceil((Number(comp.qtyPer) || 1) * quantity));
        const branchOps: any[] = [];
        await explodeBranch(compCode, compQty, 1, new Set([stockCode]), branchOps);
        if (branchOps.length > 50) {
          warnings.push(`${compCode}: branch has ${branchOps.length} operations — trimmed to 50 for simulation.`);
          branchOps.length = 50;
        }
        if (branchOps.length) subJobs.push({ label: compCode, operations: branchOps });
      }
      if (nodesVisited > MAX_NODES) {
        warnings.push(`BOM explosion stopped after ${MAX_NODES} components — quote may be incomplete.`);
      }
      if (multiLevel) {
        warnings.push(
          'Multi-level BOM: within each branch, deeper sub-assemblies are built before their parents (serialised); branches run in parallel sharing capacity.'
        );
      }
    } catch (structErr) {
      warnings.push(
        `BomStructure read failed — made-in components were not expanded into sub-legs (${(structErr as any)?.message || 'unknown error'}).`
      );
    }

    // Description for display.
    let description = '';
    try {
      const dm = await sysproDb.queryWithParams(
        `SELECT Description FROM InvMaster WHERE StockCode = @sc`, { sc: stockCode }
      );
      description = dm.recordset?.[0]?.Description || '';
    } catch { /* cosmetic only */ }

    warnings.push('Unit run times scaled linearly by quantity (setup charged once per operation).');
    res.json({ stockCode, description, quantity, operations, subJobs, warnings });
  } catch (error) {
    req.log.error({ err: error }, 'Error building routing from stock code');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/bom-tree/:stockCode
 * Read-only Structure & Routings explorer — full multi-level BOM tree with
 * per-node routing operations, straight from BomStructure/BomOperations.
 * Registered BEFORE GET /:scheduleId so the static prefix isn't shadowed.
 */
router.get('/bom-tree/:stockCode', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const stockCode = String(req.params.stockCode || '').trim();
    if (!stockCode) return res.status(400).json({ error: 'stockCode is required' });
    const result = await buildBomTree(sysproDb, stockCode);
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'Error building BOM tree');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/schedule/:scheduleId
 * Get schedule by ID
 */
router.get('/:scheduleId', async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await sysproDb.queryWithParams(
      `SELECT ScheduleData FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );

    if (!result.recordset || result.recordset.length === 0) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json({ schedule: JSON.parse(result.recordset[0].ScheduleData) });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/:scheduleId/approve
 * Approve and release schedule — updates the DB record status to 'Approved'.
 * Requires planner, company_admin, or super_admin role.
 */
router.post('/:scheduleId/approve', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    // Verify the schedule exists
    const existing = await sysproDb.queryWithParams(
      `SELECT ScheduleID, Status FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );

    if (!existing.recordset || existing.recordset.length === 0) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Persist the Approved status
    await sysproDb.queryWithParams(
      `UPDATE aps.SavedSchedules SET Status = 'Approved', SavedAt = GETDATE() WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );

    req.log.info({ scheduleId }, 'Schedule approved');
    res.json({ scheduleId, status: 'Approved' });
  } catch (error) {
    req.log.error({ err: error }, 'Error approving schedule');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/:scheduleId/export-to-syspro
 * Export schedule to Syspro via APS compatibility layer.
 *
 * The schedule is read from aps.SavedSchedules — never from the request body —
 * and must be in status 'Approved', so only a persisted, approved plan can be
 * written to SYSPRO. On success the row is marked 'Exported'.
 * Requires a planning role (see requirePlanner).
 */
router.post('/:scheduleId/export-to-syspro', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({
        error: 'Database not connected - export unavailable in read-only mode'
      });
    }

    const saved = await sysproDb.queryWithParams(
      `SELECT ScheduleData, Status FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );
    const row = saved.recordset?.[0];
    if (!row) {
      return res.status(404).json({ error: 'Schedule not found — save it before sending to SYSPRO' });
    }
    if (row.Status !== 'Approved') {
      return res.status(409).json({
        error: `Schedule is '${row.Status}'. Only an Approved schedule can be sent to SYSPRO.`
      });
    }
    const schedule = JSON.parse(row.ScheduleData);

    req.log.info({ scheduleId }, 'Exporting schedule to Syspro APS layer');
    
    // Initialize APS service and export
    const apsService = new APSDatabaseService(sysproDb);
    const exportResult = await apsService.exportSchedule(schedule);

    if (exportResult.success) {
      req.log.info({ schedulesWritten: exportResult.schedulesWritten, operationsWritten: exportResult.operationsWritten }, 'Schedule export succeeded');
      
      try {
        await sysproDb.queryWithParams(
          `UPDATE aps.SavedSchedules SET Status = 'Exported' WHERE ScheduleID = @scheduleId`,
          { scheduleId }
        );
      } catch (statusErr) {
        req.log.warn({ err: statusErr }, 'Export succeeded but status could not be set to Exported');
      }

      // Optionally cleanup old records
      try {
        await apsService.cleanupClosedOperations(1); // Clean records older than 1 day
      } catch (cleanupError) {
        req.log.warn({ err: cleanupError }, 'Cleanup warning (non-blocking)');
      }

      res.json({
        scheduleId,
        status: 'Exported',
        message: 'Schedule successfully exported to Syspro',
        details: {
          schedulesWritten: exportResult.schedulesWritten,
          operationsWritten: exportResult.operationsWritten,
          logsCreated: exportResult.logsCreated,
          executionTimeMs: exportResult.executionTimeMs
        }
      });
    } else {
      req.log.error({ errors: exportResult.errorMessages }, 'Schedule export failed');
      
      res.status(500).json({
        scheduleId,
        status: 'PartialExport',
        message: 'Schedule export completed with errors',
        details: {
          schedulesWritten: exportResult.schedulesWritten,
          operationsWritten: exportResult.operationsWritten,
          errors: exportResult.errorMessages,
          executionTimeMs: exportResult.executionTimeMs
        }
      });
    }
  } catch (error) {
    req.log.error({ err: error }, 'Fatal error during schedule export');
    res.status(500).json({ error: (error as any).message || 'Failed to export schedule' });
  }
});

/**
 * POST /api/schedule/:scheduleId/approve-override
 * Store a constraint override audit event
 */
router.post('/:scheduleId/approve-override', requirePlanner, async (req: Request, res: Response) => {
  const validation = validate(approveOverrideSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const { scheduleId } = req.params;
    const { violationId, reason } = validation.data;

    const overrides = req.app.locals.constraintOverrides || [];
    overrides.push({
      overrideId: uuidv4(),
      scheduleId,
      violationId,
      reason,
      approvedAt: new Date().toISOString()
    });
    setLocal(req.app.locals, 'constraintOverrides', overrides);

    // Audit the approval
    const schedulerDb = req.app.locals.schedulerDb;
    if (schedulerDb) {
      const actorId = (req as any).user?.username ?? String((req as any).user?.sub ?? 'anonymous');
      const traceId = (req as any).id as string | undefined;
      try {
        await new AuditLogService(schedulerDb).log({
          actorId,
          action: 'approve',
          entityType: 'override',
          entityId: violationId,
          after: { scheduleId, violationId, reason },
          traceId,
        });
      } catch (auditErr: any) {
        req.log.warn({ err: auditErr.message }, 'Failed to write audit log for approve-override');
      }
    }

    res.json({
      status: 'Approved',
      scheduleId,
      violationId
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to approve override' });
  }
});

/**
 * GET /api/schedule/constraints/violations
 * Get constraint violations for current schedule
 */
router.get('/constraints/violations', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    // Violations live inside the saved schedule JSON — read them from the
    // latest saved schedule so they survive page reloads.
    const result = await sysproDb.query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS int) AS x;
      ELSE
      SELECT TOP 1 ScheduleID, ScheduleData
      FROM aps.SavedSchedules
      WHERE IsLatest = 1
      ORDER BY SavedAt DESC
    `);

    if (!result.recordset || result.recordset.length === 0) {
      return res.json({ scheduleId: null, violations: [] });
    }

    const row = result.recordset[0];
    const schedule = JSON.parse(row.ScheduleData);
    const violations = Array.isArray(schedule?.constraintViolations)
      ? schedule.constraintViolations
      : [];

    res.json({ scheduleId: row.ScheduleID, violations });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading constraint violations');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/pin
 * Pin (freeze) a single operation's time slot.
 */
router.post('/pin', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const pin = req.body as PinnedOperation;
  if (!pin?.jobId || !pin?.opId || !pin?.resourceId || !pin?.plannedStartDate || !pin?.plannedEndDate) {
    return res.status(400).json({ error: 'Missing required pin fields: jobId, opId, resourceId, plannedStartDate, plannedEndDate' });
  }
  const key = `${pin.jobId}::${pin.opId}`;
  const pins: Record<string, PinnedOperation> = { ...(req.app.locals.pinnedOperations || {}) };
  pins[key] = { ...pin, pinnedAt: new Date().toISOString(), pinnedBy: req.user?.username };
  setLocal(req.app.locals, 'pinnedOperations', pins);
  req.log.info({ key }, 'Operation pinned');
  return res.json({ ok: true, key });
});

/**
 * DELETE /api/schedule/pin/:jobId/:opId
 * Unpin (unfreeze) a single operation's time slot.
 */
router.delete('/pin/:jobId/:opId', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const { jobId, opId } = req.params;
  const key = `${jobId}::${opId}`;
  const pins: Record<string, PinnedOperation> = { ...(req.app.locals.pinnedOperations || {}) };
  delete pins[key];
  setLocal(req.app.locals, 'pinnedOperations', pins);
  req.log.info({ key }, 'Operation unpinned');
  return res.json({ ok: true });
});

export default router;
