/**
 * Worker thread for schedule generation.
 * Runs the SchedulingEngine off the main thread so
 * Express can still serve /api/jobs, /api/resources, etc.
 */

import { parentPort, workerData } from 'worker_threads';
import { randomUUID } from 'crypto';
import { createSchedulingEngine } from './ISchedulingEngine';
import ConstraintManager from './ConstraintManager';
import { crewLookupFrom } from '../utils/crews';
import { errorMessage } from '../utils/errors';
import type { SchedulingContext } from './SchedulingEngine';
import type { Job, Operation } from '../types';
import type { WorkerPayload } from './scheduleWorkerTypes';

// Reconstruct non-serialisable types (Maps, Dates) from the plain-object payload
const ctx = workerData as WorkerPayload;

// Worker thread serialisation turns Date objects into ISO strings.
// Reconstruct them so the engine's comparisons and .getTime() calls work.
const hydrateJobs = (jobs: Job[]): Job[] =>
  jobs.map((j) => ({
    ...j,
    dueDate: new Date(j.dueDate),
    releaseDate: new Date(j.releaseDate),
    operations: (j.operations || []).map((op: Operation & { SchStartDate?: string | Date; SchEndDate?: string | Date }) => ({
      ...op,
      // Dates inside operations (if any) are also rehydrated
      SchStartDate: op.SchStartDate ? new Date(op.SchStartDate) : undefined,
      SchEndDate: op.SchEndDate ? new Date(op.SchEndDate) : undefined,
    })),
  }));

const context: SchedulingContext & {
  setupSequences?: WorkerPayload['setupSequences'];
  cpSatWeights?: WorkerPayload['cpSatWeights'];
  cpSatTimeLimitSeconds?: number;
} = {
  jobs: hydrateJobs(ctx.jobs),
  workcentres: new Map(ctx.workcentres),
  resources: new Map(ctx.resources),
  materials: new Map(ctx.materials),
  resourceCapacities: ctx.resourceCapacities ? new Map<string, number>(ctx.resourceCapacities) : undefined,
  workcentreCapacities: ctx.workcentreCapacities ? new Map<string, number>(ctx.workcentreCapacities) : undefined,
  // Per-job material plan from the route handler. Built once in the parent
  // process via SysproDatabaseService.getJobMaterialPlans so the worker
  // doesn't need its own DB connection.
  materialPlan: ctx.materialPlan ? new Map(ctx.materialPlan) : undefined,
  pinnedOperations: ctx.pinnedOperations ? new Map(ctx.pinnedOperations) : undefined,
  planningHorizonStart: new Date(ctx.planningHorizonStart),
  planningHorizonEnd: new Date(ctx.planningHorizonEnd),
  schedulingRule: ctx.schedulingRule,
  schedulingDirection: ctx.schedulingDirection,
  dateAnchorMode: ctx.dateAnchorMode,
  anchorDate: ctx.anchorDate ? new Date(ctx.anchorDate) : undefined,
  setupSequences: ctx.setupSequences,
  cpSatWeights: ctx.cpSatWeights,
  cpSatTimeLimitSeconds: ctx.cpSatTimeLimitSeconds,
  productionMode: ctx.productionMode,
  ruleToggles: ctx.ruleToggles,
  crews: crewLookupFrom(ctx.crewSetup, ctx.crewEmployees, ctx.crewShifts),
};

(async () => {
  try {
    // Wire the ConstraintManager so the engine can use calendar-aware overtime
    // checks, sequence-dependent setup times, and movement times.
    const constraintManager = new ConstraintManager();
    constraintManager.initializeConstraints(
      context.workcentres,
      context.jobs.flatMap((j) => j.operations || [])
    );
    // Load externally-supplied sequence matrix (from sch_SetupMatrix or similar)
    if (context.setupSequences?.length) {
      constraintManager.loadExternalSequences(context.setupSequences);
    }

    const scheduler = createSchedulingEngine(ctx.engineType || 'greedy', constraintManager);
    let schedule = await scheduler.schedule(context);

    // Auto-fallback: if CP-SAT sidecar was unreachable, re-run with greedy so the
    // user still gets a working schedule. Downgrade to a Warning so it doesn't
    // block the board with a Critical violation.
    if (
      ctx.engineType === 'cp-sat' &&
      schedule.constraintViolations.some((v) =>
        typeof v.description === 'string' && v.description.includes('CP-SAT sidecar unavailable')
      )
    ) {
      const greedyScheduler = createSchedulingEngine('greedy', constraintManager);
      schedule = await greedyScheduler.schedule(context);
      schedule.constraintViolations.push({
        violationId: randomUUID(),
        type: 'ScheduleDateViolation',
        severity: 'Warning',
        description: 'CP-SAT sidecar unavailable — schedule generated using greedy engine as fallback.',
        suggestedAction:
          'Start the CP-SAT sidecar (see cp-sat/ folder and README) or switch to the Greedy engine to suppress this warning.',
      });
    }

    parentPort?.postMessage({ success: true, schedule });
  } catch (err) {
    parentPort?.postMessage({ success: false, error: errorMessage(err) || String(err) });
  }
})();
