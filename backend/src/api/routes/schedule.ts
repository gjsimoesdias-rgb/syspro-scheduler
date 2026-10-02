/**
 * Schedule API routes
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Worker } from 'worker_threads';
import * as path from 'path';
import ConstraintManager from '../../services/ConstraintManager';
import { sysproServiceFor } from '../sysproServiceFor';
import SettingsService, { type SchedulingRulesSettings } from '../../services/SettingsService';
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
import { effectiveJobFlags, pinsForJobs } from '../../utils/jobFlags';
import { AuditLogService } from '../../services/AuditLogService';
import { requireAuth, requirePlanner, AuthRequest } from '../middleware/requireAuth';
import { saveAsLatest, saveIntoWhatIf, getVersion, revertToVersion, VersionError, masterRevision } from '../../services/ScheduleStore';
import type { DbExecutor } from '../../database/connection';
import { loadPublishRows, planPublish, publishStateFor, recordPublished, recordError, resetPublish, jobIdFromExportError } from '../../services/publishStatus';
import { mapEmployeeRow } from '../../utils/crews';
import { AUTO_PLAN_VERSION_ID } from '../../services/autoScheduler';
import { planDbFor } from '../../services/planStore';
import { companyFor } from '../companyContext';
import { errorMessage, errorStatus } from '../../utils/errors';

/**
 * Operation overlap from Settings → Transfer/Overlap: "Use transfer" on and
 * "Start next operation after N % of the run" below 100 → fraction N/100.
 * Anything else → no overlap.
 */
/**
 * SYSPRO employees (code + ShiftId) mapped to crews, so a crew's operators can
 * follow its people's shifts. Skipped when crews are off or nobody is mapped;
 * best-effort (an error just means no shift data → employees count always).
 */
async function loadCrewEmployees(sysproDb: any, setup: any): Promise<Array<{ code: string; shiftId?: string }> | undefined> {
  if (!sysproDb || !setup?.enabled) return undefined;
  const mapped = new Set<string>((setup.pools || []).flatMap((p: any) => p.employees || []));
  if (!mapped.size) return undefined;
  try {
    const r = await sysproDb.query(`IF OBJECT_ID('BomEmployee') IS NULL SELECT TOP 0 1 AS x ELSE SELECT * FROM BomEmployee`);
    return (r.recordset || [])
      .map((row: any) => mapEmployeeRow(row))
      .filter((e: any) => e && mapped.has(e.code))
      .map((e: any) => ({ code: e.code, shiftId: e.shiftId }));
  } catch {
    return undefined;
  }
}

function overlapFractionFrom(rules: SchedulingRulesSettings | undefined): number | undefined {
  if (rules?.useTransfer !== true) return undefined;
  const pct = Number(rules.overlapPercent);
  return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct / 100 : undefined;
}

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
export async function generateHandler(req: Request, res: Response) {
  const startedAt = Date.now();
  const validation = validate(generateScheduleSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  // Remember the planner's options for the background Auto plan (not the
  // selection, target version or exact dates — it plans everything from now).
  if (!req.autoSchedule) {
    const b = req.body || {};
    const start = Date.parse(b.planningHorizonStartDate), end = Date.parse(b.planningHorizonEndDate);
    const { selectedJobIds: _s, excludedJobIds: _e, pinnedJobIds: _p, versionId: _v, planningHorizonStartDate: _hs, planningHorizonEndDate: _he, anchorDate: _a, dateAnchorMode: _m, ...rest } = b;
    setLocal(req.app.locals, 'lastGenerateOptions', {
      ...rest,
      horizonDays: Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.max(1, Math.round((end - start) / 86400000)) : undefined,
    });
  }

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
    const sysproService = await sysproServiceFor(req, sysproDb);
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
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean; enforceMaterial: boolean; setupOncePerGroup: boolean; overlapFraction?: number; useSysproTransfer: boolean; useWaitTime: boolean; allowFinishAfterHorizon: boolean } | undefined;
    try {
      const schedulerDb = req.app.locals.schedulerDb;
      const companyId = await companyFor(req);
      if (schedulerDb && companyId) {
        const cs = await new SettingsService(schedulerDb).getCompanySettings(companyId);
        includeCompletedOps = !!cs.jobManagement?.includeCompletedOps;
        const rules = cs.fcs?.schedulingRules;
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
            overlapFraction: overlapFractionFrom(rules),
            useSysproTransfer: rules.useTransfer === true && rules.transferFromSyspro === true,
            useWaitTime: rules.useWaitTime === true,
            allowFinishAfterHorizon: rules.allowFinishAfterHorizon === true,
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

    // Jobs the planner excluded (right-click → Exclude) stay out of every run,
    // even when a selection or a master/sub family would pull them in.
    const jobFlags = effectiveJobFlags(req.app.locals.jobFlags, req.body || {});
    if (jobFlags.excluded.size > 0) {
      const before = jobs.length;
      jobs = jobs.filter((j) => !jobFlags.excluded.has(String(j.jobId).trim()));
      if (jobs.length !== before) req.log.info({ excluded: before - jobs.length }, 'Excluded jobs left out of the run');
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
    const jobPins = new Map<string, PinnedOperation>();
    const freezeDays = typeof freezeHorizonDays === 'number' && freezeHorizonDays > 0 ? freezeHorizonDays : 0;
    if (freezeDays > 0 || jobFlags.pinned.size > 0) {
      try {
        const latest = await (await planDbFor(req.app)).query(
          `IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData; ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`
        );
        if (latest.recordset?.length) {
          const saved = JSON.parse(latest.recordset[0].ScheduleData);
          // Pinned jobs (right-click → Pin) keep every op where the master has it.
          if (jobFlags.pinned.size > 0) {
            const { pins, notInPlan } = pinsForJobs(saved, jobFlags.pinned);
            for (const [k, v] of pins) jobPins.set(k, v);
            req.log.info({ pinnedJobs: jobFlags.pinned.size, pinnedOps: pins.size, notInPlan: notInPlan.length }, 'Job pins applied from the master plan');
          }
          const fenceEnd = new Date(Date.now() + freezeDays * 24 * 60 * 60 * 1000);
          for (const js of freezeDays > 0 ? saved.jobSchedules || [] : []) {
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
          if (freezeDays > 0) req.log.info({ freezeDays, frozenOps: frozenPins.size }, 'Frozen zone applied from latest saved schedule');
        } else {
          req.log.info({ freezeDays }, 'Frozen zone / job pins requested but no saved schedule exists — nothing to hold');
        }
      } catch (err) {
        req.log.warn({ err }, 'Frozen zone / job pins requested but latest schedule could not be loaded; continuing without them');
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
      // Crew pools (Manage → Crews); the worker builds the engine lookup.
      crewSetup: req.app.locals.crewSetup,
      // Employees' SYSPRO shifts + CRUX shift templates → crew size by shift.
      crewEmployees: await loadCrewEmployees(sysproDb, req.app.locals.crewSetup),
      crewShifts: req.app.locals.shiftTemplates || [],
      // Pinned operations — serialised as [key, PinnedOperation][] for the worker.
      // Frozen-zone auto-pins are merged first; manual pins override them.
      pinnedOperations: (() => {
        // Precedence: frozen zone < pinned jobs < manual operation pins.
        const merged = new Map<string, any>(frozenPins);
        for (const [key, pin] of jobPins) merged.set(key, pin);
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
    let masterRevisionOut: number | undefined;
    if (targetVersionId) {
      try {
        await saveIntoWhatIf(await planDbFor(req.app), targetVersionId, schedule);
        schedule.scheduleId = targetVersionId;
        req.log.info({ versionId: targetVersionId }, 'Schedule saved into what-if version');
      } catch (saveErr) {
        return res.status(errorStatus(saveErr) || 500).json({ error: errorMessage(saveErr, 'Could not save into the what-if version') });
      }
    } else {
      try {
        const { jobCount, revision } = await saveAsLatest(await planDbFor(req.app), schedule, {
          status: 'Draft', generatedAt: new Date(), createdBy: req.user?.username,
        });
        masterRevisionOut = revision;
        req.log.info({ jobCount, revision }, 'Schedule auto-saved to DB');
      } catch (saveErr) {
        req.log.warn({ err: saveErr }, 'Could not auto-save schedule to DB (non-blocking)');
      }
    }

    res.json({
      schedule,
      // New master revision when the run replaced the master (not for what-ifs).
      ...(masterRevisionOut !== undefined ? { masterRevision: masterRevisionOut } : {}),
      executionTimeMs: Date.now() - startedAt,
      warningCount: schedule.constraintViolations.filter((c: any) => c.severity === 'Warning').length,
      errorCount: schedule.constraintViolations.filter((c: any) => c.severity === 'Critical').length
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error generating schedule');
    res.status(500).json({ error: errorMessage(error, 'Failed to generate schedule') });
  }
}
router.post('/generate', requirePlanner, generateHandler);

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
    const sysproService = await sysproServiceFor(req, sysproDb);
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
    let ruleToggles: { useQueueTime: boolean; useSetupTime: boolean; useMoveTime: boolean; setupOncePerGroup: boolean; overlapFraction?: number; useSysproTransfer: boolean; useWaitTime: boolean; allowFinishAfterHorizon: boolean } | undefined;
    try {
      const schedulerDb = req.app.locals.schedulerDb;
      const companyId = await companyFor(req);
      if (schedulerDb && companyId) {
        const cs = await new SettingsService(schedulerDb).getCompanySettings(companyId);
        includeCompletedOps = !!cs.jobManagement?.includeCompletedOps;
        const rulesCfg = cs.fcs?.schedulingRules;
        if (rulesCfg) {
          ruleToggles = {
            useQueueTime: rulesCfg.useQueueTime !== false,
            useSetupTime: rulesCfg.useSetupTime !== false,
            useMoveTime: rulesCfg.useMoveTime !== false,
            setupOncePerGroup: rulesCfg.setupFirstJobOnly === true,
            overlapFraction: overlapFractionFrom(rulesCfg),
            useSysproTransfer: rulesCfg.useTransfer === true && rulesCfg.transferFromSyspro === true,
            useWaitTime: rulesCfg.useWaitTime === true,
            allowFinishAfterHorizon: rulesCfg.allowFinishAfterHorizon === true,
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
    const optimizeExcluded = effectiveJobFlags(req.app.locals.jobFlags, req.body || {}).excluded;
    if (optimizeExcluded.size > 0) jobs = jobs.filter((j) => !optimizeExcluded.has(String(j.jobId).trim()));

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
      // Crew pools (Manage → Crews); the worker builds the engine lookup.
      crewSetup: req.app.locals.crewSetup,
      // Employees' SYSPRO shifts + CRUX shift templates → crew size by shift.
      crewEmployees: await loadCrewEmployees(sysproDb, req.app.locals.crewSetup),
      crewShifts: req.app.locals.shiftTemplates || [],
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
          error: errorMessage(err, 'Run failed'),
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
    res.status(500).json({ error: errorMessage(error, 'Failed to optimize') });
  }
});

/**
 * GET /api/schedule/latest
 * Load the most recently saved schedule from DB
 */
/**
 * Background Auto plan (services/autoScheduler.ts).
 *   GET  /api/schedule/auto        { config, status, versionId }
 *   PUT  /api/schedule/auto        { enabled?, intervalMinutes?, onJobChange?, checkMinutes? }
 *   POST /api/schedule/auto/run    re-plan the Auto plan what-if now
 */
const autoOf = (req: Request) => req.app.locals.autoScheduler as import('../../services/autoScheduler').AutoScheduler | undefined;
router.get('/auto', (req: Request, res: Response) => {
  const auto = autoOf(req);
  if (!auto) return res.status(503).json({ error: 'Auto plan is not available' });
  res.json({ config: auto.config, status: auto.status, versionId: auto.status.versionId ?? AUTO_PLAN_VERSION_ID });
});
router.put('/auto', requireAuth, requirePlanner, (req: AuthRequest, res: Response) => {
  const auto = autoOf(req);
  if (!auto) return res.status(503).json({ error: 'Auto plan is not available' });
  const body = req.body || {};
  const config = auto.setConfig({
    ...body,
    // The run uses the settings of the company of whoever switched it on.
    ...(body.enabled ? { companyId: req.user?.companyId, enabledBy: req.user?.username } : {}),
  });
  req.log?.info({ config, user: req.user?.username }, 'Auto plan settings changed');
  res.json({ config, status: auto.status });
});
router.post('/auto/run', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const auto = autoOf(req);
  if (!auto) return res.status(503).json({ error: 'Auto plan is not available' });
  if (!auto.config.companyId) auto.setConfig({ companyId: req.user?.companyId });
  const status = await auto.runNow(`run now by ${req.user?.username || 'planner'}`);
  res.status(status.lastResult?.ok ? 200 : 500).json({ status });
});

/** Which of these job numbers have no WipMaster row (checked in chunks of 500). */
async function jobsMissingFromSyspro(sysproDb: any, jobIds: string[]): Promise<Set<string>> {
  const missing = new Set(jobIds);
  for (let i = 0; i < jobIds.length; i += 500) {
    const chunk = jobIds.slice(i, i + 500);
    const params = Object.fromEntries(chunk.map((id, n) => [`j${n}`, id]));
    const r = await sysproDb.queryWithParams(
      `SELECT Job FROM WipMaster WHERE Job IN (${chunk.map((_, n) => `@j${n}`).join(', ')})`, params);
    for (const row of r.recordset || []) missing.delete(String(row.Job).trim());
  }
  return missing;
}

/** Sends to SYSPRO in progress, by company plan schema. */
const exportsRunning = new Set<string>();

/**
 * Export applies to the master plan only (IsLatest, not a what-if).
 * Returns an error to send, or null when `scheduleId` is the master.
 */
async function masterCheck(plan: DbExecutor, scheduleId: string): Promise<{ status: number; error: string } | null> {
  const r = await plan.queryWithParams(
    `SELECT IsLatest, VersionKind FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`, { scheduleId });
  const row = r.recordset?.[0];
  if (!row) return { status: 404, error: 'Schedule not found — save it before sending to SYSPRO' };
  if (row.VersionKind === 'WhatIf') return { status: 409, error: 'This is a what-if. Commit it to the master plan (Versions) first.' };
  if (!row.IsLatest) return { status: 409, error: 'This is not the master plan. Revert to it (Versions) first.' };
  return null;
}

async function auditPlan(req: Request, action: string, scheduleId: string): Promise<void> {
  const schedulerDb = req.app.locals.schedulerDb;
  if (!schedulerDb) return;
  try {
    await new AuditLogService(schedulerDb).log({
      actorId: req.user?.username ?? String(req.user?.sub ?? 'unknown'),
      action, entityType: 'plan_version', entityId: scheduleId, traceId: req.id != null ? String(req.id) : undefined,
    });
  } catch (err) {
    req.log.warn({ err }, `Audit log write failed for ${action}`);
  }
}

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await (await planDbFor(req.app)).query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS int) AS x;
      ELSE
      SELECT TOP 1 ScheduleID, ScheduleData, Status, JobCount, OperationCount,
        HorizonStart, HorizonEnd, GeneratedAt, SavedAt, Revision
      FROM aps.SavedSchedules
      WHERE IsLatest = 1
      ORDER BY SavedAt DESC
    `);

    if (!result.recordset || result.recordset.length === 0) {
      return res.json({ schedule: null });
    }

    const row = result.recordset[0];
    const schedule = JSON.parse(row.ScheduleData);
    // The row's Status is authoritative (export updates the row, not
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
        savedAt: row.SavedAt,
        // Send back as baseRevision on /save (optimistic concurrency).
        revision: Number(row.Revision) || 0
      }
    });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading latest schedule');
    res.status(500).json({ error: errorMessage(error) });
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
    // The master revision the board was loaded from. Omitted by old clients
    // (no check); null = "no master when I loaded".
    const rawBase = (req.body as any).baseRevision;
    const baseRevision = rawBase === undefined ? undefined : rawBase === null ? null : Number(rawBase);
    if (baseRevision !== undefined && baseRevision !== null && !Number.isFinite(baseRevision)) {
      return res.status(400).json({ error: 'baseRevision must be a number or null' });
    }

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    // Any saved change is a new Draft (until it is sent to SYSPRO). Atomic — see ScheduleStore.
    const { jobCount, operationCount, revision } = await saveAsLatest(await planDbFor(req.app), schedule, {
      status: 'Draft', baseRevision, createdBy: req.user?.username,
    });

    req.log.info({ scheduleId: schedule.scheduleId, jobCount, operationCount, revision }, 'Schedule saved');
    res.json({ saved: true, scheduleId: schedule.scheduleId, revision });
  } catch (error) {
    if (error instanceof VersionError) {
      return res.status(error.status).json({ error: error.message, code: (error as any).code, currentRevision: (error as any).currentRevision });
    }
    req.log.error({ err: error }, 'Error saving schedule');
    res.status(500).json({ error: errorMessage(error) });
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

    // Same rules as Versions → Revert: what-ifs must be committed instead, and
    // the restored plan comes back as Draft.
    const plan = await planDbFor(req.app);
    await revertToVersion(plan, scheduleId);
    const restored = await getVersion(plan, scheduleId);
    if (!restored) return res.status(404).json({ error: 'Schedule version not found' });
    const schedule = { ...restored.schedule, status: restored.summary.status };
    const restoredAt = new Date().toISOString();

    req.log.info({ scheduleId, restoredAt }, 'version_restore');

    res.json({ schedule, restoredAt, revision: await masterRevision(plan) });
  } catch (error) {
    if (error instanceof VersionError) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: errorMessage(error) });
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
    const latest = await (await planDbFor(req.app)).query(`
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
    return res.status(500).json({ error: errorMessage(error) });
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
    const latest = await (await planDbFor(req.app)).query(`
      IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData;
      ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`);
    const data = latest.recordset?.[0]?.ScheduleData;
    if (!data) return res.json({ jobs: [], counts: { Published: 0, Pending: 0, Error: 0 } });
    const jobs = publishStateFor(JSON.parse(data), await loadPublishRows(await planDbFor(req.app)));
    const counts = { Published: 0, Pending: 0, Error: 0 } as Record<string, number>;
    for (const j of jobs) counts[j.state]++;
    res.json({ jobs, counts });
  } catch (error) {
    req.log.error({ err: error }, 'Error reading publish status');
    res.status(500).json({ error: errorMessage(error) });
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
    res.json({ reset: await resetPublish(await planDbFor(req.app), jobIds) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

router.get('/:scheduleId', async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await (await planDbFor(req.app)).queryWithParams(
      `SELECT ScheduleData FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );

    if (!result.recordset || result.recordset.length === 0) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json({ schedule: JSON.parse(result.recordset[0].ScheduleData) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * POST /api/schedule/:scheduleId/export-to-syspro
 * Export schedule to Syspro via APS compatibility layer.
 *
 * The schedule is read from aps.SavedSchedules — never from the request body —
 * and must be the master plan (what-ifs are committed first). There is no
 * separate approval step: the planner's confirm in the UI is the sign-off,
 * and the send is audit-logged. On success the row is marked 'Exported'.
 * Requires a planning role (see requirePlanner).
 */
router.post('/:scheduleId/export-to-syspro', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  let lockedSchema: string | null = null;
  try {
    const { scheduleId } = req.params;

    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(503).json({
        error: 'Database not connected - export unavailable in read-only mode'
      });
    }

    const plan = await planDbFor(req.app);
    const problem = await masterCheck(plan, scheduleId);
    if (problem) return res.status(problem.status).json({ error: problem.error });

    // One export per company at a time: a double click or a second planner
    // would otherwise write the same jobs (and LYNQ BPL orders) twice.
    const lockKey = String((plan as any).schema ?? 'default');
    if (exportsRunning.has(lockKey)) {
      return res.status(409).json({ error: 'A send to SYSPRO is already running for this company — wait for it to finish.' });
    }
    exportsRunning.add(lockKey);
    lockedSchema = lockKey;

    const saved = await plan.queryWithParams(
      `SELECT ScheduleData, Status FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );
    const row = saved.recordset?.[0];
    if (!row) return res.status(404).json({ error: 'Schedule not found' });
    await auditPlan(req, 'export_to_syspro', scheduleId);
    const schedule = JSON.parse(row.ScheduleData);

    // Incremental publish: only jobs whose machine or dates changed since the
    // last successful send. { full: true } re-sends every scheduled job.
    const full = req.body?.full === true;
    const publishRows = await loadPublishRows(await planDbFor(req.app));
    const planned = planPublish(schedule, publishRows, full);
    const { unchanged } = planned;
    const user = req.user?.username;

    // Bulk-imported jobs that SYSPRO doesn't have would fail "No WipMaster row
    // updated" and roll back the whole send. Leave them out and say so.
    const importedIds = new Set<string>(((req.app.locals.importedJobs || []) as any[]).map((j) => String(j?.jobId ?? '').trim()));
    const importedCandidates = planned.toPublish.filter((j: any) => importedIds.has(String(j.jobId).trim()));
    const notInSyspro = importedCandidates.length
      ? await jobsMissingFromSyspro(sysproDb, importedCandidates.map((j: any) => String(j.jobId).trim()))
      : new Set<string>();
    const toPublish = planned.toPublish.filter((j: any) => !notInSyspro.has(String(j.jobId).trim()));
    const skipped = Array.from(notInSyspro);
    if (skipped.length) req.log.info({ skipped }, 'Imported jobs not in SYSPRO left out of the send');

    if (toPublish.length === 0) {
      await (await planDbFor(req.app)).queryWithParams(
        `UPDATE aps.SavedSchedules SET Status = 'Exported' WHERE ScheduleID = @scheduleId`, { scheduleId });
      return res.json({
        scheduleId, status: 'Exported',
        message: `Nothing changed since the last send — ${unchanged.length} jobs already up to date in SYSPRO` +
          (skipped.length ? `; ${skipped.length} imported job(s) not in SYSPRO were left out` : ''),
        details: { schedulesWritten: 0, operationsWritten: 0, unchanged: unchanged.length, skippedNotInSyspro: skipped },
      });
    }

    req.log.info({ scheduleId, sending: toPublish.length, unchanged: unchanged.length, full }, 'Exporting schedule to Syspro APS layer');

    // Initialize APS service and export
    const apsService = new APSDatabaseService(sysproDb);
    const exportResult = await apsService.exportSchedule(schedule, { onlyJobs: toPublish });

    if (exportResult.success) {
      try {
        await recordPublished(await planDbFor(req.app), toPublish, scheduleId, user);
      } catch (statusErr) {
        req.log.warn({ err: statusErr }, 'Export succeeded but per-job publish status could not be recorded');
      }
      req.log.info({ schedulesWritten: exportResult.schedulesWritten, operationsWritten: exportResult.operationsWritten }, 'Schedule export succeeded');
      
      try {
        await (await planDbFor(req.app)).queryWithParams(
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
          skippedNotInSyspro: skipped,
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
        if (job) await recordError(await planDbFor(req.app), job, scheduleId, message);
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
    res.status(500).json({ error: errorMessage(error, 'Failed to export schedule') });
  } finally {
    if (lockedSchema !== null) exportsRunning.delete(lockedSchema);
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
      const actorId = req.user?.username ?? String(req.user?.sub ?? 'anonymous');
      const traceId = (req.id != null ? String(req.id) : undefined);
      try {
        await new AuditLogService(schedulerDb).log({
          actorId,
          action: 'approve',
          entityType: 'override',
          entityId: violationId,
          after: { scheduleId, violationId, reason },
          traceId,
        });
      } catch (auditErr) {
        req.log.warn({ err: errorMessage(auditErr) }, 'Failed to write audit log for approve-override');
      }
    }

    res.json({
      status: 'Approved',
      scheduleId,
      violationId
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error, 'Failed to approve override') });
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
    const result = await (await planDbFor(req.app)).query(`
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
    res.status(500).json({ error: errorMessage(error) });
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
