/**
 * Schedule API routes
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';
import * as path from 'path';
import ConstraintManager from '../../services/ConstraintManager';
import SysproDatabaseService from '../../services/SysproDatabaseService';
import SettingsService from '../../services/SettingsService';
import APSDatabaseService from '../../services/APSDatabaseService';
import environment from '../../config/environment';
import { Job, ScheduleRequest, PinnedOperation } from '../../types';
import { validate, generateScheduleSchema, saveScheduleSchema, approveOverrideSchema, optimizeScheduleSchema } from '../validators/scheduleValidators';
import { applyAssignedShiftCalendars } from './scheduleShared';
import changeoverRoutes, { buildClassChangeoverSequences } from './changeovers';
import ctpRoutes from './ctp';
import { rankRuleResults, RULE_LABELS, ALL_RULES, type SchedulingRule, type RuleResult } from '../../services/RuleOptimizerService';
import { setLocal } from '../../utils/setLocal';
import { completeJobFamilies } from '../../utils/jobFamilies';
import { stripCompletedOperations } from '../../utils/jobFilters';
import { AuditLogService } from '../../services/AuditLogService';
import { requireAuth, requirePlanner, AuthRequest } from '../middleware/requireAuth';
import { saveAsLatest, promoteToLatest, saveIntoWhatIf } from '../../services/ScheduleStore';
import { loadPublishRows, planPublish, publishStateFor, recordPublished, recordError, resetPublish, jobIdFromExportError } from '../../services/publishStatus';

const router = Router();

// Static sub-routes first: they must win over GET /:scheduleId.
router.use(changeoverRoutes);
router.use(ctpRoutes);

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
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean; enforceMaterial: boolean; setupOncePerGroup: boolean } | undefined;
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
            // Settings → Setup → "Apply to the first job in the autoscheduling group only".
            setupOncePerGroup: rules.setupFirstJobOnly === true,
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
    // With a versionId the run goes into that what-if and the master is untouched.
    const targetVersionId = typeof req.body?.versionId === 'string' ? req.body.versionId : undefined;
    if (targetVersionId) {
      try {
        await saveIntoWhatIf(sysproDb, targetVersionId, schedule);
        schedule.scheduleId = targetVersionId;
        req.log.info({ versionId: targetVersionId }, 'Schedule saved into what-if version');
      } catch (saveErr: any) {
        return res.status(saveErr?.status || 500).json({ error: saveErr?.message || 'Could not save into the what-if version' });
      }
    } else {
      try {
        const { jobCount } = await saveAsLatest(sysproDb, schedule, {
          status: 'Draft', generatedAt: new Date(), createdBy: (req as any).user?.username,
        });
        req.log.info({ jobCount }, 'Schedule auto-saved to DB');
      } catch (saveErr) {
        req.log.warn({ err: saveErr }, 'Could not auto-save schedule to DB (non-blocking)');
      }
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
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean; setupOncePerGroup: boolean } | undefined;
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
            setupOncePerGroup: rulesCfg.setupFirstJobOnly === true,
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
    // The row's Status is authoritative (approve/export update the row, not
    // the JSON), so the board doesn't show an exported plan as "Draft".
    if (row.Status) schedule.status = row.Status;

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

/**
 * POST /api/schedule/pins/time-fence { until }
 * Time-fence lock (LYNQ "Time Fence Lock"): pin every operation of the master
 * plan that starts before `until`, at its current machine and times. The next
 * generate keeps them where they are.
 */
router.post('/pins/time-fence', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const until = new Date(String(req.body?.until || ''));
  if (Number.isNaN(until.getTime())) return res.status(400).json({ error: 'until must be a date/time' });
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const latest = await sysproDb.query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData;
      ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`);
    const data = latest.recordset?.[0]?.ScheduleData;
    if (!data) return res.status(404).json({ error: 'There is no master plan to lock yet' });
    const schedule = JSON.parse(data);
    const pins: Record<string, PinnedOperation> = { ...(req.app.locals.pinnedOperations || {}) };
    const now = new Date().toISOString();
    let added = 0;
    for (const job of schedule.jobSchedules || []) {
      for (const op of job.operationSchedules || []) {
        const start = new Date(op.setupStart || op.plannedStartDate);
        if (Number.isNaN(start.getTime()) || start >= until || !op.resourceId) continue;
        const key = `${job.jobId}::${op.opId}`;
        if (!pins[key]) added++;
        pins[key] = {
          jobId: job.jobId, opId: op.opId, workcentreId: op.workcentreId, resourceId: op.resourceId,
          plannedStartDate: new Date(op.plannedStartDate).toISOString(),
          plannedEndDate: new Date(op.plannedEndDate).toISOString(),
          pinnedAt: now, pinnedBy: req.user?.username,
        };
      }
    }
    setLocal(req.app.locals, 'pinnedOperations', pins);
    req.log.info({ until: until.toISOString(), added }, 'Time-fence lock applied');
    return res.json({ ok: true, added, total: Object.keys(pins).length });
  } catch (error) {
    req.log.error({ err: error }, 'Time-fence lock failed');
    return res.status(500).json({ error: (error as any).message });
  }
});

/**
 * DELETE /api/schedule/pins[?before=ISO]
 * Remove all locks (LYNQ "Remove All Locks"), or only those starting before a date
 * (time-fence unlock).
 */
router.delete('/pins', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const pins: Record<string, PinnedOperation> = { ...(req.app.locals.pinnedOperations || {}) };
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  if (before && Number.isNaN(before.getTime())) return res.status(400).json({ error: 'before must be a date/time' });
  let removed = 0;
  for (const [key, pin] of Object.entries(pins)) {
    if (!before || new Date(pin.plannedStartDate) < before) { delete pins[key]; removed++; }
  }
  setLocal(req.app.locals, 'pinnedOperations', pins);
  req.log.info({ removed, before: before?.toISOString() }, 'Locks removed');
  return res.json({ ok: true, removed, total: Object.keys(pins).length });
});

/**
 * GET /api/schedule/:scheduleId
 * Get schedule by ID
 */
/**
 * GET /api/schedule/publish-status
 * Per-job publish state of the master plan: Published (SYSPRO has these
 * dates), Pending (changed or never sent), Error (last send failed on it).
 */
router.get('/publish-status', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const latest = await sysproDb.query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData;
      ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`);
    const data = latest.recordset?.[0]?.ScheduleData;
    if (!data) return res.json({ jobs: [], counts: { Published: 0, Pending: 0, Error: 0 } });
    const jobs = publishStateFor(JSON.parse(data), await loadPublishRows(sysproDb));
    const counts = { Published: 0, Pending: 0, Error: 0 } as Record<string, number>;
    for (const j of jobs) counts[j.state]++;
    res.json({ jobs, counts });
  } catch (error) {
    req.log.error({ err: error }, 'Error reading publish status');
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * POST /api/schedule/publish-status/reset { jobIds }
 * Forget the last send for these jobs so the next "Send to SYSPRO" includes them.
 */
router.post('/publish-status/reset', requirePlanner, async (req: Request, res: Response) => {
  const jobIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds.map(String).filter(Boolean).slice(0, 5000) : [];
  if (!jobIds.length) return res.status(400).json({ error: 'jobIds is required' });
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    res.json({ reset: await resetPublish(sysproDb, jobIds) });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

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

    // Incremental publish: only jobs whose machine or dates changed since the
    // last successful send. { full: true } re-sends every scheduled job.
    const full = req.body?.full === true;
    const publishRows = await loadPublishRows(sysproDb);
    const { toPublish, unchanged } = planPublish(schedule, publishRows, full);
    const user = (req as any).user?.username;

    if (toPublish.length === 0) {
      await sysproDb.queryWithParams(
        `UPDATE aps.SavedSchedules SET Status = 'Exported' WHERE ScheduleID = @scheduleId`, { scheduleId });
      return res.json({
        scheduleId, status: 'Exported',
        message: `Nothing changed since the last send — ${unchanged.length} jobs already up to date in SYSPRO`,
        details: { schedulesWritten: 0, operationsWritten: 0, unchanged: unchanged.length },
      });
    }

    req.log.info({ scheduleId, sending: toPublish.length, unchanged: unchanged.length, full }, 'Exporting schedule to Syspro APS layer');

    // Initialize APS service and export
    const apsService = new APSDatabaseService(sysproDb);
    const exportResult = await apsService.exportSchedule(schedule, { onlyJobs: toPublish });

    if (exportResult.success) {
      try {
        await recordPublished(sysproDb, toPublish, scheduleId, user);
      } catch (statusErr) {
        req.log.warn({ err: statusErr }, 'Export succeeded but per-job publish status could not be recorded');
      }
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
          unchanged: unchanged.length,
          executionTimeMs: exportResult.executionTimeMs
        }
      });
    } else {
      req.log.error({ errors: exportResult.errorMessages }, 'Schedule export failed');
      // The transaction rolled back, so nothing was written. Flag the job the
      // error names (if any) so it shows as Error in the job list.
      try {
        const message = exportResult.errorMessages.join('; ');
        const culprit = jobIdFromExportError(message, toPublish.map((j: any) => j.jobId));
        const job = culprit ? toPublish.find((j: any) => j.jobId === culprit) : null;
        if (job) await recordError(sysproDb, job, scheduleId, message);
      } catch (statusErr) {
        req.log.warn({ err: statusErr }, 'Could not record per-job publish error');
      }
      
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
