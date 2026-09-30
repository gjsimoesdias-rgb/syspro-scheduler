/**
 * CpSatEngine — ISchedulingEngine adapter for the Python CP-SAT sidecar.
 *
 * Serialises a SchedulingContext to the JSON contract expected by
 * cp-sat/main.py (POST /solve) and maps the response back to the standard
 * Schedule shape used by the rest of the backend.
 *
 * If the sidecar is unreachable or returns a non-200 response the engine
 * falls back gracefully: it returns an empty schedule with a single
 * Critical ConstraintViolation describing the problem.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ISchedulingEngine } from './ISchedulingEngine';
import type { SchedulingContext } from './SchedulingEngine';
import { logger } from '../utils/logger';
import { exceptionForDay, exceptionWindowMinutes } from '../utils/calendarExceptions';
import type {
  Schedule,
  JobSchedule,
  OperationSchedule,
  ResourceLoad,
  ConstraintViolation,
  ScheduleMetrics,
  Calendar,
} from '../types';
import environment from '../config/environment';

/**
 * Convert a resource Calendar into a list of [start_epoch_sec, end_epoch_sec]
 * availability windows over the given planning horizon.
 *
 * Each shift on each working day within the horizon produces one window.
 * Non-working days and holiday dates produce no windows.
 * If the calendar has no shifts, we fall back to workingHoursPerDay starting
 * at 08:00.
 */
function calendarToAvailabilityWindows(
  calendar: Calendar,
  horizonStart: Date,
  horizonEnd: Date,
): number[][] {
  const windows: number[][] = [];
  const MS_PER_DAY = 86_400_000;

  // Determine shifts to use
  const shifts =
    calendar.shifts && calendar.shifts.length > 0
      ? calendar.shifts
      : [
          {
            shiftId: '__default',
            name: 'Day Shift',
            startTime: '08:00',
            endTime: `${String(8 + Math.max(1, calendar.workingHoursPerDay)).padStart(2, '0')}:00`,
            breakTime: 0,
          },
        ];

  // Iterate day by day
  let cursor = new Date(horizonStart);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(horizonEnd);
  end.setUTCHours(23, 59, 59, 999);

  while (cursor <= end) {
    const jsDay = cursor.getUTCDay(); // 0=Sunday … 6=Saturday
    const dateStr = cursor.toISOString().slice(0, 10);

    // Holidays / short days / extra working days override the weekly pattern.
    const exception = exceptionForDay(calendar, dateStr);
    const forced = exception ? exceptionWindowMinutes(exception) : null;
    const isWorkingDay = exception ? true : calendar.workingDays.includes(jsDay);
    const dayShifts: Array<{ startMin: number; endMin: number }> = forced
      ? forced.map((w) => ({ startMin: w.start, endMin: w.end }))
      : shifts.map((sh) => {
          const [startH, startM] = sh.startTime.split(':').map(Number);
          const [endH, endM] = sh.endTime.split(':').map(Number);
          return { startMin: startH * 60 + startM, endMin: endH * 60 + endM };
        });

    if (isWorkingDay) {
      for (const shift of dayShifts) {
        const dayEpoch = cursor.getTime() / 1000; // midnight UTC in seconds
        const shiftStart = dayEpoch + shift.startMin * 60;
        let shiftEnd = dayEpoch + shift.endMin * 60;

        // Handle overnight shifts (e.g. 22:00–06:00)
        if (shiftEnd <= shiftStart) shiftEnd += 86_400;

        // Clamp to horizon
        const winStart = Math.max(shiftStart, Math.floor(horizonStart.getTime() / 1000));
        const winEnd = Math.min(shiftEnd, Math.ceil(horizonEnd.getTime() / 1000));

        if (winEnd > winStart) {
          windows.push([winStart, winEnd]);
        }
      }
    }

    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }

  return windows;
}

// ── Sidecar wire types ────────────────────────────────────────────────────────

interface SolveRequest {
  horizon_start_epoch: number;
  horizon_end_epoch: number;
  jobs: Array<{
    job_id: string;
    priority: number;
    due_date_epoch_seconds: number;
    release_date_epoch_seconds: number | null;
    line_group_id: string | null;
    /** SYSPRO master/sub hierarchy: this job must finish before its master starts. */
    master_job_id: string | null;
  }>;
  operations: Array<{
    op_id: string;
    job_id: string;
    sequence: number;
    workcentre_id: string;
    duration_minutes: number;
    setup_time_minutes: number;
    queue_time_minutes: number;
    move_time_minutes: number;
    qualified_resource_ids: string[];
  }>;
  resources: Array<{
    resource_id: string;
    workcentre_id: string;
    capacity_units: number;
    availability_windows: number[][];
    line_group_id: string | null;
  }>;
  weights: {
    tardiness: number;
    makespan: number;
    changeover: number;
  };
  time_limit_seconds: number;
}

interface ScheduledOperation {
  op_id: string;
  job_id: string;
  resource_id: string;
  workcentre_id: string;
  start_epoch: number;
  end_epoch: number;
  setup_start_epoch: number;
  setup_end_epoch: number;
  run_start_epoch: number;
  run_end_epoch: number;
  queue_end_epoch: number;
  move_end_epoch: number;
  sequence: number;
  is_overtime: boolean;
}

interface SolveResponse {
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | string;
  objective_value: number | null;
  tardiness_score: number | null;
  makespan_minutes: number | null;
  changeover_minutes: number | null;
  scheduled_operations: ScheduledOperation[];
  unscheduled_job_ids: string[];
  solve_time_seconds: number;
  solver_status_code: number;
}

// ── Multi-objective weights (passed via SchedulingContext extension) ───────────

export interface ObjectiveWeights {
  tardiness: number;  // 0–100
  makespan: number;   // 0–100
  changeover: number; // 0–100
}

// Attach weights to SchedulingContext via module augmentation
declare module './SchedulingEngine' {
  interface SchedulingContext {
    /** CP-SAT objective weights (0–100 each). Defaults to 33/33/34. */
    cpSatWeights?: ObjectiveWeights;
    /** Solver wall-clock time limit in seconds. Default: 30. */
    cpSatTimeLimitSeconds?: number;
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class CpSatSchedulingEngine implements ISchedulingEngine {
  private readonly sidecarUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    this.sidecarUrl = environment.cpSatUrl ?? 'http://localhost:5050';
    this.timeoutMs = 120_000; // 2-minute HTTP timeout
  }

  async schedule(context: SchedulingContext): Promise<Schedule> {
    const scheduleId = uuidv4();
    const t0 = Date.now();

    const horizonStart = Math.floor(context.planningHorizonStart.getTime() / 1000);
    const horizonEnd = Math.floor(context.planningHorizonEnd.getTime() / 1000);

    const weights = context.cpSatWeights ?? { tardiness: 33, makespan: 33, changeover: 34 };
    const timeLimit = context.cpSatTimeLimitSeconds ?? 30;

    // ── Build solve request ──────────────────────────────────────────────────
    const solveReq: SolveRequest = {
      horizon_start_epoch: horizonStart,
      horizon_end_epoch: horizonEnd,
      jobs: context.jobs.map(j => ({
        job_id: j.jobId,
        priority: j.priority,
        due_date_epoch_seconds: Math.floor(j.dueDate.getTime() / 1000),
        release_date_epoch_seconds: j.releaseDate
          ? Math.floor(j.releaseDate.getTime() / 1000)
          : null,
        line_group_id: (context.productionMode === 'flow-line' ||
          (context.productionMode === 'mixed' && j.productionMode === 'flow-line'))
          ? (j as any).lineGroupId ?? null
          : null,
        master_job_id: (j.masterJobId as string | null) ?? null,
      })),
      operations: context.jobs.flatMap(j =>
        (j.operations ?? []).map(op => ({
          op_id: op.opId,
          job_id: j.jobId,
          sequence: op.sequence,
          workcentre_id: op.workcentreId,
          duration_minutes: op.duration,
          // Company rule toggles (Settings → FCS → Scheduling Rules): a
          // disabled component is zeroed for the solver, same as the greedy path.
          setup_time_minutes: context.ruleToggles?.useSetupTime === false ? 0 : op.setupTime,
          queue_time_minutes: context.ruleToggles?.useQueueTime === false ? 0 : op.queueTime,
          move_time_minutes: context.ruleToggles?.useMoveTime === false ? 0 : op.moveTime,
          qualified_resource_ids: op.qualifiedResourceIds ?? [],
        }))
      ),
      resources: Array.from(context.resources.values()).map(r => ({
        resource_id: r.resourceId,
        workcentre_id: r.worcentreId,
        capacity_units: 1,
        availability_windows: r.calendar
          ? calendarToAvailabilityWindows(r.calendar, context.planningHorizonStart, context.planningHorizonEnd)
          : [],
        line_group_id: r.lineGroupId ?? null,
      })),
      weights: {
        tardiness: weights.tardiness / 100,
        makespan: weights.makespan / 100,
        changeover: weights.changeover / 100,
      },
      time_limit_seconds: timeLimit,
    };

    // ── Call sidecar ─────────────────────────────────────────────────────────
    let sidecarResp: SolveResponse;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const httpResp = await fetch(`${this.sidecarUrl}/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(solveReq),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!httpResp.ok) {
        const body = await httpResp.text().catch(() => '');
        throw new Error(`CP-SAT sidecar returned HTTP ${httpResp.status}: ${body}`);
      }
      sidecarResp = (await httpResp.json()) as SolveResponse;
    } catch (err: unknown) {
      logger.error({ err }, 'CpSatEngine: sidecar call failed');
      return this.buildEmptySchedule(
        scheduleId,
        context,
        `CP-SAT sidecar unavailable: ${(err as Error).message}`,
        Date.now() - t0
      );
    }

    if (sidecarResp.status === 'INFEASIBLE' || sidecarResp.scheduled_operations.length === 0) {
      return this.buildEmptySchedule(
        scheduleId,
        context,
        `CP-SAT solver returned ${sidecarResp.status}. ` +
          `Unscheduled jobs: ${sidecarResp.unscheduled_job_ids.join(', ') || 'none'}`,
        Date.now() - t0
      );
    }

    // ── Map to JobSchedule[] ─────────────────────────────────────────────────
    const opsByJob = new Map<string, ScheduledOperation[]>();
    for (const so of sidecarResp.scheduled_operations) {
      const list = opsByJob.get(so.job_id) ?? [];
      list.push(so);
      opsByJob.set(so.job_id, list);
    }

    const jobSchedules: JobSchedule[] = context.jobs.map(job => {
      const scheduled = opsByJob.get(job.jobId) ?? [];
      scheduled.sort((a, b) => a.sequence - b.sequence);

      const opSchedules: OperationSchedule[] = scheduled.map(so => {
        const op = (job.operations ?? []).find(o => o.opId === so.op_id);
        const totalDurationMin = Math.round((so.end_epoch - so.start_epoch) / 60);
        return {
          opId: so.op_id,
          workcentreId: so.workcentre_id,
          resourceId: so.resource_id,
          plannedStartDate: new Date(so.start_epoch * 1000),
          plannedEndDate: new Date(so.end_epoch * 1000),
          duration: totalDurationMin,
          setupTime: op?.setupTime ?? Math.round((so.setup_end_epoch - so.setup_start_epoch) / 60),
          runTime: op?.duration ?? Math.round((so.run_end_epoch - so.run_start_epoch) / 60),
          queueTime: op?.queueTime ?? Math.round((so.queue_end_epoch - so.run_end_epoch) / 60),
          moveTime: op?.moveTime ?? Math.round((so.move_end_epoch - so.queue_end_epoch) / 60),
          setupStart: new Date(so.setup_start_epoch * 1000),
          setupEnd: new Date(so.setup_end_epoch * 1000),
          runStart: new Date(so.run_start_epoch * 1000),
          runEnd: new Date(so.run_end_epoch * 1000),
          queueEnd: new Date(so.queue_end_epoch * 1000),
          moveEnd: new Date(so.move_end_epoch * 1000),
          sequence: so.sequence,
          isOvertimeSlot: so.is_overtime,
          batchSize: op?.batchSize ?? 1,
          slackTime: 0,
        };
      });

      const hasOps = opSchedules.length > 0;
      const plannedStart = hasOps ? opSchedules[0].plannedStartDate : context.planningHorizonStart;
      const plannedEnd = hasOps
        ? opSchedules[opSchedules.length - 1].moveEnd
        : context.planningHorizonStart;

      const tardinessDays = Math.max(
        0,
        (plannedEnd.getTime() - job.dueDate.getTime()) / 86_400_000
      );

      return {
        jobId: job.jobId,
        plannedStartDate: plannedStart,
        plannedEndDate: plannedEnd,
        operationSchedules: opSchedules,
        estimatedTardiness: tardinessDays,
        status: (sidecarResp.unscheduled_job_ids.includes(job.jobId)
          ? 'ConstraintViolation'
          : 'Scheduled') as JobSchedule['status'],
      };
    });

    // ── Resource loads ───────────────────────────────────────────────────────
    const resourceLoads = this.buildResourceLoads(sidecarResp.scheduled_operations, context);

    // ── Metrics ──────────────────────────────────────────────────────────────
    const metrics = this.calculateMetrics(jobSchedules, resourceLoads, sidecarResp);

    const violations: ConstraintViolation[] = sidecarResp.unscheduled_job_ids.map(jid => ({
      violationId: uuidv4(),
      type: 'ScheduleDateViolation' as const,
      severity: 'Critical' as const,
      affectedJobId: jid,
      description: `Job ${jid} could not be scheduled by CP-SAT within the planning horizon.`,
      suggestedAction: 'Extend the planning horizon or relax constraints.',
    }));

    return {
      scheduleId,
      scheduledDate: new Date(),
      version: 1,
      status: 'Draft',
      planningHorizon: {
        startDate: context.planningHorizonStart,
        endDate: context.planningHorizonEnd,
      },
      jobSchedules,
      resourceLoads,
      constraintViolations: violations,
      metrics,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildResourceLoads(
    scheduledOps: ScheduledOperation[],
    context: SchedulingContext
  ): ResourceLoad[] {
    // Group by resource → day
    const loads = new Map<string, Map<string, number>>(); // resourceId → date-str → minutes

    for (const so of scheduledOps) {
      const dayStr = new Date(so.start_epoch * 1000).toISOString().slice(0, 10);
      const mins = Math.round((so.end_epoch - so.start_epoch) / 60);
      const inner = loads.get(so.resource_id) ?? new Map<string, number>();
      inner.set(dayStr, (inner.get(dayStr) ?? 0) + mins);
      loads.set(so.resource_id, inner);
    }

    const result: ResourceLoad[] = [];
    for (const [resourceId, dayMap] of loads) {
      for (const [dayStr, totalMins] of dayMap) {
        const regularMins = Math.min(totalMins, 480); // 8h cap
        const otMins = Math.max(0, totalMins - 480);
        result.push({
          resourceId,
          date: new Date(dayStr),
          regularHours: regularMins / 60,
          overtimeHours: otMins / 60,
          utilizationRate: Math.min(100, (totalMins / 480) * 100),
          assignedOperations: [],
        });
      }
    }
    return result;
  }

  private calculateMetrics(
    jobSchedules: JobSchedule[],
    resourceLoads: ResourceLoad[],
    resp: SolveResponse
  ): ScheduleMetrics {
    const tardyJobs = jobSchedules.filter(j => j.estimatedTardiness > 0);
    const avgTardiness =
      tardyJobs.length > 0
        ? tardyJobs.reduce((s, j) => s + j.estimatedTardiness, 0) / tardyJobs.length
        : 0;

    const avgUtilization =
      resourceLoads.length > 0
        ? resourceLoads.reduce((s, r) => s + r.utilizationRate, 0) / resourceLoads.length
        : 0;

    const totalOT = resourceLoads.reduce((s, r) => s + r.overtimeHours, 0);

    return {
      totalJobsScheduled: jobSchedules.filter(j => j.status === 'Scheduled').length,
      jobsOnTime: jobSchedules.length - tardyJobs.length,
      jobsTardy: tardyJobs.length,
      averageTardiness: Math.round(avgTardiness * 10) / 10,
      resourceUtilization: Math.round(avgUtilization),
      overtimeHours: Math.round(totalOT * 10) / 10,
      criticalPathLength: (resp.makespan_minutes ?? 0) / 60,
      totalSetupTime: 0,
      totalQueueTime: 0,
      totalMoveTime: 0,
    };
  }

  private buildEmptySchedule(
    scheduleId: string,
    context: SchedulingContext,
    message: string,
    executionTimeMs: number
  ): Schedule {
    const violation: ConstraintViolation = {
      violationId: uuidv4(),
      type: 'ScheduleDateViolation',
      severity: 'Critical',
      description: message,
      suggestedAction:
        'Ensure the CP-SAT sidecar is running (see cp-sat/ folder) and CP_SAT_URL is set correctly.',
    };

    return {
      scheduleId,
      scheduledDate: new Date(),
      version: 1,
      status: 'Draft',
      planningHorizon: {
        startDate: context.planningHorizonStart,
        endDate: context.planningHorizonEnd,
      },
      jobSchedules: context.jobs.map(j => ({
        jobId: j.jobId,
        plannedStartDate: context.planningHorizonStart,
        plannedEndDate: context.planningHorizonStart,
        operationSchedules: [],
        estimatedTardiness: 0,
        status: 'Unschedulable',
      })),
      resourceLoads: [],
      constraintViolations: [violation],
      metrics: {
        totalJobsScheduled: 0,
        jobsOnTime: 0,
        jobsTardy: context.jobs.length,
        averageTardiness: 0,
        resourceUtilization: 0,
        overtimeHours: 0,
        criticalPathLength: 0,
        totalSetupTime: 0,
        totalQueueTime: 0,
        totalMoveTime: 0,
      },
    };
  }
}
