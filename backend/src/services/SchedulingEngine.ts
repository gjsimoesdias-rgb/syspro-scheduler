/**
 * Core finite capacity scheduling engine
 * Implements job, operation, and resource scheduling with constraints
 */

import { localDayKey } from '../utils/calendarExceptions';
import { dayWindowMinutes } from '../utils/shiftWindows';
import type { CalendarLike } from '../utils/calendarExceptions';

/** A machine/line calendar as the day logic reads it (may be missing). */
type Cal = CalendarLike | null | undefined;
import type { CrewLookup } from '../utils/crews';
import { CrewLoad } from './crewLoad';
import { v4 as uuidv4 } from 'uuid';
import {
  Job,
  Operation,
  Workcentre,
  Resource,
  Material,
  Schedule,
  JobSchedule,
  OperationSchedule,
  ResourceLoad,
  ConstraintViolation,
  ScheduleMetrics,
  ProductionMode,
  PinnedOperation
} from '../types';
import environment from '../config/environment';
import ConstraintManager from './ConstraintManager';
import { logger } from '../utils/logger';

/** Per-job material availability passed in by the route handler. */
export interface JobMaterialPlanLite {
  jobId: string;
  status: 'Materials' | 'Partial' | 'No Materials';
  available: boolean;
  shortages: Array<{
    componentCode: string;
    requiredQty: number;
    availableQty: number;
    shortageQty: number;
    unitOfMeasure?: string;
  }>;
}

export interface SchedulingContext {
  jobs: Job[];
  workcentres: Map<string, Workcentre>;
  resources: Map<string, Resource>;
  materials: Map<string, Material>;
  resourceCapacities?: Map<string, number>;
  workcentreCapacities?: Map<string, number>;
  /**
   * Optional per-job material plan. When present, scheduleJob /
   * scheduleJobBackward call checkMaterialAvailability against this
   * map and emit a Critical ConstraintViolation per shortage. When
   * absent (e.g. unit tests, callers that haven't been updated), the
   * engine assumes materials are available and behaves as before.
   */
  materialPlan?: Map<string, JobMaterialPlanLite>;
  planningHorizonStart: Date;
  planningHorizonEnd: Date;
  schedulingRule?: 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio';
  schedulingDirection?: 'forward' | 'backward';
  dateAnchorMode?: 'manual' | 'syspro';
  anchorDate?: Date;
  /** System-wide production mode. Default 'job-shop'. */
  productionMode?: ProductionMode;
  /**
   * Pinned operations — pre-placed by the user.  The key is "jobId::opId".
   * The scheduler books these slots before running and won't re-schedule them.
   */
  pinnedOperations?: Map<string, PinnedOperation>;
  /**
   * Crew (labour) pools — Manage → Crews. When set, operations on a line in a
   * pool only run while the pool has enough free operators. Forward scheduling.
   */
  crews?: CrewLookup;
  /**
   * Company rule toggles (Settings → FCS → Scheduling Rules). Each defaults
   * to true; setting one to false removes that time component from every
   * operation in the run (including sequence-dependent setup for
   * useSetupTime and inter-workcentre movement for useMoveTime).
   */
  ruleToggles?: {
    useQueueTime?: boolean;
    useSetupTime?: boolean;
    useMoveTime?: boolean;
    /**
     * When false, jobs with material shortages are scheduled anyway (the
     * MaterialShortage violations are still emitted as warnings so the planner
     * can see them). Defaults to true — short jobs are blocked.
     */
    enforceMaterial?: boolean;
    /**
     * Setup once per group (Settings → Setup → "Apply to the first job in the
     * autoscheduling group only"). When true, an operation that follows the
     * same stock code on its line gets no setup (an explicit changeover-matrix
     * entry for that pair still applies), and jobs for the same item are
     * grouped behind the first one when their due dates are close
     * (campaignWindowDays). Default false.
     */
    setupOncePerGroup?: boolean;
    /** Due-date window for grouping same-item jobs (days). Default 7. */
    campaignWindowDays?: number;
    /**
     * Operation overlap (Settings → Transfer/Overlap). A fraction in (0, 1):
     * the next operation may start once this share of the previous
     * operation's run has elapsed (plus move time), instead of waiting for
     * it to finish. The next operation still cannot finish before the last
     * transfer batch reaches it. Undefined or >= 1 → no overlap. Forward
     * scheduling only.
     */
    overlapFraction?: number;
    /**
     * Use SYSPRO's per-operation transfer (TransferQtyOrPct / TransferQtyPct)
     * for overlap. An operation's own value wins over overlapFraction.
     */
    useSysproTransfer?: boolean;
    /** Apply SYSPRO IWaitTime: elapsed wait after an op before the next starts. Default false. */
    useWaitTime?: boolean;
    /**
     * Operations must start inside the planning window but may finish after
     * it (up to a year). Otherwise an operation longer than the window can
     * never be scheduled. Each such op gets an Info note. Default false.
     */
    allowFinishAfterHorizon?: boolean;
  };
}

export interface OperationSlot {
  opId: string;
  jobId: string;
  workcentreId: string;
  start: Date;       // machine-booked start (= setupStart)
  end: Date;         // machine-booked end (= runEnd)
  resourceId: string;
  isOvertime: boolean;
  /** Minutes of the booking inside Overtime shift windows (0 when none). */
  overtimeMinutes?: number;
  duration: number;  // machine-booked minutes (setup+run)
  // Phase breakdown (minutes)
  setupTime: number;
  runTime: number;
  queueTime: number;
  moveTime: number;
  // Phase timestamps
  setupStart: Date;
  setupEnd: Date;
  runStart: Date;
  runEnd: Date;
  queueEnd: Date;
  moveEnd: Date;
  // Capacity window: only setup+run occupy the machine
  capacityStart: Date;
  capacityEnd: Date;
  sequence: number;
  /** Item made in this slot — lets a later op find its true predecessor on the line. */
  itemCode?: string;
}

export { localDayKey };

/**
 * Slot search probes "which booked slots overlap [start, end)?" many times per
 * operation. Filtering the whole list each time made placement O(n²) per line.
 * Sort once by capacityStart and binary-search: only slots starting in
 * [start − longest slot, end) can overlap.
 */
const MAX_SLOT_ITERATIONS = 20000;

export function overlapIndex(slots: OperationSlot[]): (start: Date, end: Date) => OperationSlot[] {
  const sorted = [...slots].sort((a, b) => a.capacityStart.getTime() - b.capacityStart.getTime());
  const starts = sorted.map((s) => s.capacityStart.getTime());
  let longest = 0;
  for (const s of sorted) longest = Math.max(longest, s.capacityEnd.getTime() - s.capacityStart.getTime());
  const lowerBound = (t: number) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return (start: Date, end: Date) => {
    const s = start.getTime(), e = end.getTime();
    const out: OperationSlot[] = [];
    for (let i = lowerBound(s - longest); i < sorted.length && starts[i] < e; i++) {
      if (sorted[i].capacityEnd.getTime() > s) out.push(sorted[i]);
    }
    return out;
  };
}

/**
 * Is a resource with `capacity` parallel units full anywhere in [start, end)?
 * Counting every slot that touches the window over-counted: two back-to-back
 * jobs on a 2-unit machine looked like 2 in parallel and blocked a third that
 * would fit. For capacity > 1 use the peak number running at the same time.
 */
export function capacityFull(slots: OperationSlot[], start: Date, end: Date, capacity: number): boolean {
  if (capacity <= 1 || slots.length < capacity) return slots.length >= capacity;
  const s = start.getTime(), e = end.getTime();
  const events: Array<[number, number]> = [];
  for (const slot of slots) {
    events.push([Math.max(s, slot.capacityStart.getTime()), 1]);
    events.push([Math.min(e, slot.capacityEnd.getTime()), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at the same instant
  let running = 0;
  for (const [, delta] of events) {
    running += delta;
    if (running >= capacity) return true;
  }
  return false;
}

/**
 * Campaign grouping for setup-once-per-group: keep the rule's order, but pull
 * each later job for the same item up behind the first one when its due date
 * is within `windowDays` of that first job's due date. Jobs without an item
 * code are left where they are.
 */
export function groupSameItemJobs(jobs: Job[], windowDays: number): Job[] {
  const windowMs = Math.max(0, windowDays) * 86_400_000;
  const used = new Set<number>();
  const out: Job[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (used.has(i)) continue;
    const lead = jobs[i];
    used.add(i);
    out.push(lead);
    const item = String(lead.itemCode || '').trim();
    if (!item) continue;
    const leadDue = lead.dueDate ? new Date(lead.dueDate).getTime() : NaN;
    for (let k = i + 1; k < jobs.length; k++) {
      if (used.has(k)) continue;
      const other = jobs[k];
      if (String(other.itemCode || '').trim() !== item) continue;
      const due = other.dueDate ? new Date(other.dueDate).getTime() : NaN;
      if (Number.isFinite(leadDue) && Number.isFinite(due) && due - leadDue > windowMs) continue;
      used.add(k);
      out.push(other);
    }
  }
  return out;
}

export class SchedulingEngine {
  private resourceLoads: Map<string, OperationSlot[]> = new Map();
  private workcentreLoads: Map<string, OperationSlot[]> = new Map();
  private constraints: ConstraintViolation[] = [];
  private constraintManager?: ConstraintManager;
  /** Tracks the last item code produced on each resource for sequence-dependent setup time. */
  private lastItemPerResource: Map<string, string> = new Map();

  constructor(constraintManager?: ConstraintManager) {
    this.constraintManager = constraintManager;
  }

  /**
   * Per-workcentre × per-day cumulative overtime hours, recomputed as the
   * engine places operations. The key is `${workcentreId}|${YYYY-MM-DD}`.
   */
  private overtimeUsage: Map<string, number> = new Map();
  /** Workcentre+day pairs we've already emitted a violation for (dedup). */
  private overtimeFlagged: Set<string> = new Set();
  /** jobId|componentCode pairs for which a MaterialShortage violation has been emitted (dedup). */
  private materialViolationsSeen: Set<string> = new Set();
  /** Ops whose slot search stopped at MAX_SLOT_ITERATIONS (explained in the violation). */
  private searchCapHit: Set<string> = new Set();
  /** Ops whose earliest free slot would end after the planning horizon. */
  private beyondHorizon: Set<string> = new Set();
  /** Crew bookings for this run (null when crews are off). */
  private crewLoad: CrewLoad | null = null;
  /** opIds whose line needs more operators than its whole crew has. */
  private crewTooSmall: Set<string> = new Set();
  /** opIds that found no slot because their crew stayed busy to the end of the window. */
  private crewBlocked: Set<string> = new Set();
  /**
   * Per-workcentre overtime budget, populated in initializeLoads from
   * workcentre.maxOvertimePerDay (with env default fallback). Read on each
   * placement to decide whether to emit a Warning violation.
   */
  private overtimeBudget: Map<string, number> = new Map();

  /**
   * Windows per (calendar, local day), memoised: the slot search asks for the
   * same day thousands of times and rebuilding it was the engine's top cost.
   * Callers treat the result as read-only. Cleared at the start of each run.
   */
  private windowCache = new WeakMap<object, Map<number, Array<{ start: Date; end: Date; overtime?: boolean }>>>();
  private static readonly NO_CALENDAR = {};

  private getProductiveWindowsForDay(calendar: Cal, date: Date): Array<{ start: Date; end: Date; overtime?: boolean }> {
    const cacheKey = calendar && typeof calendar === 'object' ? calendar : SchedulingEngine.NO_CALENDAR;
    let byDay = this.windowCache.get(cacheKey);
    if (!byDay) this.windowCache.set(cacheKey, (byDay = new Map()));
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const dayMs = day.getTime();
    let windows = byDay.get(dayMs);
    if (!windows) byDay.set(dayMs, (windows = this.computeProductiveWindowsForDay(calendar, day)));
    return windows;
  }

  private computeProductiveWindowsForDay(calendar: Cal, date: Date): Array<{ start: Date; end: Date; overtime?: boolean }> {
    // Shared with CtpService (utils/shiftWindows) so CTP always mirrors the engine.
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return dayWindowMinutes(calendar, day).map(({ start, end, overtime }) => {
      const s = new Date(day); s.setMinutes(start, 0, 0);
      const e = new Date(day); e.setMinutes(end, 0, 0);
      return overtime ? { start: s, end: e, overtime } : { start: s, end: e };
    });
  }

  private fitsProductiveWindow(start: Date, end: Date, calendar: Cal): boolean {
    return this.getProductiveWindowsForDay(calendar, start).some(
      (window) => start >= window.start && start < window.end && end > start && end <= window.end
    );
  }

  private findContiguousProductiveStart(date: Date, requiredMinutes: number, calendar: Cal): Date | null {
    const requiredMs = Math.max(0, requiredMinutes) * 60 * 1000;
    let probe = new Date(date);

    for (let i = 0; i < 60; i++) {
      const windows = this.getProductiveWindowsForDay(calendar, probe);
      for (const window of windows) {
        const candidateStart = probe <= window.start
          ? new Date(window.start)
          : (probe < window.end ? new Date(probe) : null);

        if (!candidateStart) {
          continue;
        }

        if (requiredMs === 0 || candidateStart.getTime() + requiredMs <= window.end.getTime()) {
          return candidateStart;
        }
      }

      const nextDay = new Date(probe);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      probe = nextDay;
    }

    return null;
  }

  private addMinutesAcrossProductiveWindows(start: Date, requiredMinutes: number, calendar: Cal): Date | null {
    if (requiredMinutes <= 0) {
      return new Date(start);
    }

    let remainingMs = requiredMinutes * 60 * 1000;
    let cursor = new Date(start);

    for (let i = 0; i < 2000 && remainingMs > 0; i++) { // long ops on multi-break calendars need many windows
      const productiveStart = this.nextProductiveStart(cursor, calendar);
      if (!productiveStart) {
        return null;
      }

      const windows = this.getProductiveWindowsForDay(calendar, productiveStart);
      const window = windows.find((item) => productiveStart >= item.start && productiveStart < item.end)
        || windows.find((item) => item.end > productiveStart);

      if (!window) {
        const nextDay = new Date(productiveStart);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        cursor = nextDay;
        continue;
      }

      const segmentStartMs = Math.max(productiveStart.getTime(), window.start.getTime());
      const availableMs = Math.max(0, window.end.getTime() - segmentStartMs);

      if (availableMs >= remainingMs) {
        return new Date(segmentStartMs + remainingMs);
      }

      remainingMs -= availableMs;
      cursor = new Date(window.end.getTime()); // back-to-back windows (e.g. Production then Overtime) join without a lost minute
    }

    return null;
  }

  private nextProductiveStart(date: Date, calendar: Cal): Date | null {
    let probe = new Date(date);

    for (let i = 0; i < 60; i++) {
      const windows = this.getProductiveWindowsForDay(calendar, probe);
      for (const window of windows) {
        if (probe <= window.start) {
          return new Date(window.start);
        }
        if (probe > window.start && probe < window.end) {
          return new Date(probe);
        }
      }

      const nextDay = new Date(probe);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      probe = nextDay;
    }

    return null;
  }

  private previousProductiveEnd(date: Date, calendar: Cal): Date | null {
    let probe = new Date(date);

    for (let i = 0; i < 60; i++) {
      const windows = this.getProductiveWindowsForDay(calendar, probe);
      for (let j = windows.length - 1; j >= 0; j--) {
        const window = windows[j];
        if (probe >= window.end) {
          return new Date(window.end);
        }
        if (probe > window.start && probe <= window.end) {
          return new Date(probe);
        }
      }

      const previousDay = new Date(probe);
      previousDay.setDate(previousDay.getDate() - 1);
      previousDay.setHours(23, 59, 59, 999);
      probe = previousDay;
    }

    return null;
  }

  private subtractMinutesAcrossProductiveWindows(end: Date, requiredMinutes: number, calendar: Cal): Date | null {
    if (requiredMinutes <= 0) {
      return new Date(end);
    }

    if (!calendar) {
      return new Date(end.getTime() - requiredMinutes * 60 * 1000);
    }

    let remainingMs = requiredMinutes * 60 * 1000;
    let cursor = new Date(end);

    for (let i = 0; i < 2000 && remainingMs > 0; i++) { // long ops on multi-break calendars need many windows
      const productiveEnd = this.previousProductiveEnd(cursor, calendar);
      if (!productiveEnd) {
        return null;
      }

      const windows = this.getProductiveWindowsForDay(calendar, productiveEnd);
      let window: { start: Date; end: Date } | null = null;
      for (let j = windows.length - 1; j >= 0; j--) {
        if (productiveEnd > windows[j].start) {
          window = windows[j];
          break;
        }
      }

      if (!window) {
        const previousDay = new Date(productiveEnd);
        previousDay.setDate(previousDay.getDate() - 1);
        previousDay.setHours(23, 59, 59, 999);
        cursor = previousDay;
        continue;
      }

      const segmentEndMs = Math.min(productiveEnd.getTime(), window.end.getTime());
      const availableMs = Math.max(0, segmentEndMs - window.start.getTime());

      if (availableMs >= remainingMs) {
        return new Date(segmentEndMs - remainingMs);
      }

      remainingMs -= availableMs;
      cursor = new Date(window.start.getTime() - 60 * 1000);
    }

    return null;
  }

  async schedule(context: SchedulingContext): Promise<Schedule> {
    const scheduleId = uuidv4();
    const startTime = Date.now();

    try {
      // Reset state
      this.resourceLoads.clear();
      this.workcentreLoads.clear();
      this.windowCache = new WeakMap();
      this.constraints = [];
      this.materialViolationsSeen.clear();
      this.searchCapHit.clear();
      this.beyondHorizon.clear();
      this.crewTooSmall.clear();
      this.crewBlocked.clear();
      this.crewLoad = context.crews ? new CrewLoad(context.crews) : null;

      // Step 1: Sort jobs by rule and due date
      const ordered = this.prioritizeJobs(context.jobs, context.schedulingRule || 'priority');
      const prioritizedJobs = context.ruleToggles?.setupOncePerGroup
        ? groupSameItemJobs(ordered, context.ruleToggles.campaignWindowDays ?? 7)
        : ordered;

      // Step 2: Initialize capacity loads
      this.initializeLoads(context);

      // Step 2b: Pre-book pinned operations so regular scheduling works around them
      if (context.pinnedOperations?.size) {
        this.prePlacePinnedOps(context);
      }

      // Step 2c: Master/sub-job precedence (SYSPRO WipMasterSub).
      // A sub-job feeds its master job, so every sub-job must finish before
      // the master may start. Order the run so the independent side is placed
      // first (forward: sub-jobs first; backward: master first) and constrain
      // the dependent side to the already-placed dates.
      const backward = context.schedulingDirection === 'backward';
      const jobsInRun = new Set(prioritizedJobs.map((j) => j.jobId));
      const subJobsByMaster = new Map<string, Job[]>();
      for (const j of prioritizedJobs) {
        const masterId = (j.masterJobId as string | null) || null;
        if (masterId && masterId !== j.jobId && jobsInRun.has(masterId)) {
          const list = subJobsByMaster.get(masterId) || [];
          list.push(j);
          subJobsByMaster.set(masterId, list);
        }
      }
      const orderedJobs = this.orderForMasterPrecedence(prioritizedJobs, subJobsByMaster, backward);

      // Step 3: Schedule each job
      const jobSchedules: JobSchedule[] = [];
      const scheduledById = new Map<string, JobSchedule>();
      for (let ji = 0; ji < orderedJobs.length; ji++) {
        const job = orderedJobs[ji];
        if ((ji + 1) % 20 === 0 || ji === 0) {
          logger.info({ jobIndex: ji + 1, total: orderedJobs.length, jobId: job.jobId }, 'Scheduling job');
        }

        let jobSchedule: JobSchedule;
        if (backward) {
          // Master was scheduled first — each sub-job must END before the master STARTS.
          const masterId = (job.masterJobId as string | null) || null;
          const masterSchedule = masterId ? scheduledById.get(masterId) : undefined;
          let latestEnd: Date | undefined;
          if (masterId && jobsInRun.has(masterId)) {
            if (masterSchedule?.operationSchedules.length) {
              latestEnd = masterSchedule.plannedStartDate;
            } else {
              this.emitMasterPrecedenceWarning(masterId, job.jobId);
            }
          }
          jobSchedule = await this.scheduleJobBackward(job, context, latestEnd);
        } else {
          // Sub-jobs were scheduled first — the master cannot START before every sub-job ENDS.
          const subs = subJobsByMaster.get(job.jobId);
          let earliestStart: Date | undefined;
          if (subs?.length) {
            for (const sub of subs) {
              const subSchedule = scheduledById.get(sub.jobId);
              if (subSchedule?.operationSchedules.length) {
                if (!earliestStart || subSchedule.plannedEndDate > earliestStart) {
                  earliestStart = subSchedule.plannedEndDate;
                }
              } else {
                this.emitMasterPrecedenceWarning(job.jobId, sub.jobId);
              }
            }
          }
          jobSchedule = await this.scheduleJob(job, context, earliestStart);
        }

        jobSchedules.push(jobSchedule);
        scheduledById.set(job.jobId, jobSchedule);
      }

      // Step 4: Build resource load histogram
      const resourceLoads = this.buildResourceLoads(context);

      // Step 5: Calculate metrics
      const metrics = this.calculateMetrics(jobSchedules, resourceLoads, context);

      logger.info({ jobs: jobSchedules.length, ms: Date.now() - startTime }, 'Scheduling run finished');

      return {
        scheduleId,
        scheduledDate: new Date(),
        version: 1,
        status: 'Draft',
        planningHorizon: {
          startDate: context.planningHorizonStart,
          endDate: context.planningHorizonEnd
        },
        jobSchedules,
        resourceLoads,
        constraintViolations: this.constraints,
        metrics
      };
    } catch (error) {
      logger.error({ err: error }, 'Scheduling error');
      throw error;
    }
  }

  /**
   * Stable topological reorder for master/sub-job precedence.
   * Forward: sub-jobs are hoisted before their master. Backward: the master
   * is hoisted before its sub-jobs. Priority order is preserved everywhere
   * else, and nested hierarchies (a sub-job that is itself a master) resolve
   * transitively. Malformed cycles are broken silently rather than looping.
   */
  private orderForMasterPrecedence(
    jobs: Job[],
    subJobsByMaster: Map<string, Job[]>,
    backward: boolean
  ): Job[] {
    if (subJobsByMaster.size === 0) return jobs;

    const byId = new Map(jobs.map((j) => [j.jobId, j] as const));
    const visited = new Set<string>();
    const result: Job[] = [];

    const visit = (job: Job, stack: Set<string>): void => {
      if (visited.has(job.jobId) || stack.has(job.jobId)) return;
      stack.add(job.jobId);

      const deps: Job[] = backward
        ? (() => {
            const master = byId.get((job.masterJobId as string) || '');
            return master && master.jobId !== job.jobId ? [master] : [];
          })()
        : subJobsByMaster.get(job.jobId) || [];

      for (const dep of deps) visit(dep, stack);

      stack.delete(job.jobId);
      visited.add(job.jobId);
      result.push(job);
    };

    for (const job of jobs) visit(job, new Set());
    return result;
  }

  /** Warn that a master/sub pair could not have its precedence enforced. */
  private emitMasterPrecedenceWarning(masterJobId: string, subJobId: string): void {
    this.constraints.push({
      violationId: uuidv4(),
      type: 'MasterJobPrecedence',
      severity: 'Warning',
      affectedJobId: masterJobId,
      description: `Sub-job ${subJobId} of master job ${masterJobId} has no scheduled operations — the "sub-jobs finish before the master starts" rule could not be enforced for this pair`,
      suggestedAction: 'Resolve the sub-job\'s constraint violations, then regenerate the schedule'
    });
  }

  private prioritizeJobs(jobs: Job[], rule: 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio' = 'priority'): Job[] {
    const now = new Date();

    // Calculate job-level metrics
    const jobMetrics = jobs.map(job => {
      const totalDuration = (job.operations || []).reduce((sum, op) => sum + op.duration, 0);
      const timeRemaining = Math.max(0, job.dueDate.getTime() - now.getTime());
      const criticalRatio = totalDuration > 0 ? timeRemaining / (totalDuration * 60000) : Infinity;
      
      return { job, totalDuration, timeRemaining, criticalRatio };
    });

    switch (rule) {
      case 'edd': // Earliest Due Date
        return jobMetrics.sort((a, b) => a.job.dueDate.getTime() - b.job.dueDate.getTime()).map(m => m.job);
      
      case 'fifo': // First In First Out (by release date)
        return jobMetrics.sort((a, b) => (a.job.releaseDate?.getTime() || 0) - (b.job.releaseDate?.getTime() || 0)).map(m => m.job);
      
      case 'spt': // Shortest Processing Time
        return jobMetrics.sort((a, b) => a.totalDuration - b.totalDuration).map(m => m.job);
      
      case 'critical-ratio': // Critical Ratio
        return jobMetrics.sort((a, b) => a.criticalRatio - b.criticalRatio).map(m => m.job);
      
      case 'priority':
      default: // Priority (ascending) -> DueDate (ascending)
        return jobMetrics.sort((a, b) => {
          if (a.job.priority !== b.job.priority) {
            return a.job.priority - b.job.priority;
          }
          return a.job.dueDate.getTime() - b.job.dueDate.getTime();
        }).map(m => m.job);
    }
  }

  private initializeLoads(context: SchedulingContext): void {
    // Reset overtime trackers for the new schedule run.
    this.overtimeUsage.clear();
    this.overtimeFlagged.clear();
    this.overtimeBudget.clear();
    context.workcentres.forEach((wc, id) => {
      this.overtimeBudget.set(
        id,
        wc.maxOvertimePerDay || environment.maxOvertimePerDay
      );
    });

    // Initialize empty slots for all resources and workcentres
    context.resources.forEach((_, resourceId) => {
      this.resourceLoads.set(resourceId, []);
    });

    context.workcentres.forEach((_, worcentreId) => {
      this.workcentreLoads.set(worcentreId, []);
    });
  }

  /**
   * Pre-book pinned operation slots into resourceLoads / workcentreLoads so
   * that the regular scheduling pass treats them as already occupied.
   */
  private prePlacePinnedOps(context: SchedulingContext): void {
    if (!context.pinnedOperations?.size) return;

    for (const [key, pin] of context.pinnedOperations) {
      const start = new Date(pin.plannedStartDate);
      const end = new Date(pin.plannedEndDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) continue;

      const durationMin = (end.getTime() - start.getTime()) / 60000;
      const slot: OperationSlot = {
        opId: pin.opId,
        jobId: pin.jobId,
        workcentreId: pin.workcentreId,
        start,
        end,
        resourceId: pin.resourceId,
        isOvertime: false,
        duration: durationMin,
        setupTime: 0,
        runTime: durationMin,
        queueTime: 0,
        moveTime: 0,
        setupStart: start,
        setupEnd: start,
        runStart: start,
        runEnd: end,
        queueEnd: end,
        moveEnd: end,
        capacityStart: start,
        capacityEnd: end,
        sequence: 0,
        itemCode: context.jobs.find((j) => j.jobId === pin.jobId)?.itemCode,
      };

      // Ensure the resource/workcentre lists exist (pinned resource might not
      // be in context.resources if it was manually assigned).
      const resourceSlots = this.resourceLoads.get(pin.resourceId) ?? [];
      const workcentreSlots = this.workcentreLoads.get(pin.workcentreId) ?? [];
      resourceSlots.push(slot);
      workcentreSlots.push(slot);
      this.resourceLoads.set(pin.resourceId, resourceSlots);
      this.workcentreLoads.set(pin.workcentreId, workcentreSlots);

      logger.debug({ key, start: start.toISOString(), end: end.toISOString() }, 'Pre-booked pinned operation slot');
    }
  }

  private async scheduleJob(
    job: Job,
    context: SchedulingContext,
    /** Master-job precedence: the job may not start before this instant. */
    earliestStartOverride?: Date
  ): Promise<JobSchedule> {
    const operationSchedules: OperationSchedule[] = [];
    let predecessorEnd = job.releaseDate > context.planningHorizonStart
      ? job.releaseDate
      : context.planningHorizonStart;
    if (earliestStartOverride && earliestStartOverride > predecessorEnd) {
      predecessorEnd = earliestStartOverride;
    }
    let previousWorkcentreId: string | null = null;
    // Previous operation's slot, for operation overlap (transfer batches).
    let previousSlot: OperationSlot | null = null;
    let previousWasSubcontract = false;
    const globalOverlap = context.ruleToggles?.overlapFraction;
    const validFraction = (f: unknown): f is number => typeof f === 'number' && f > 0 && f < 1;

    // Flow-line: once the first operation is placed on a resource that belongs to
    // a line group, all subsequent operations of this job must also use resources
    // from the same line group.
    const effectiveMode: ProductionMode =
      (job.productionMode) ||
      (context.productionMode) ||
      'job-shop';
    const isFlowLine = effectiveMode === 'flow-line' ||
      (effectiveMode === 'mixed' && !!job.productionMode && job.productionMode === 'flow-line');
    let lockedLineGroupId: string | null = null;

    // Sort operations by sequence to enforce strict ordering
    const sortedOps = [...job.operations].sort((a, b) => a.sequence - b.sequence);

    try {
      // Material availability is a job-level concern — check once before placing
      // any operation. checkMaterialAvailability emits one Critical violation
      // per shortage line (see method body), so we don't need to construct
      // anything more here.
      const materialCheck = await this.checkMaterialAvailability(job, context);
      if (!materialCheck.available && context.ruleToggles?.enforceMaterial !== false) {
        return {
          jobId: job.jobId,
          plannedStartDate: job.releaseDate,
          plannedEndDate: job.dueDate,
          operationSchedules: [],
          estimatedTardiness: 0,
          status: 'ConstraintViolation'
        };
      }

      for (let i = 0; i < sortedOps.length; i++) {
        const operation = sortedOps[i];

        // Queue time is a pre-start constraint for this operation and does not book the machine.
        // Move time is applied on the previous operation via predecessorEnd.
        let interOpGapMinutes = 0;
        if (context.ruleToggles?.useMoveTime !== false && i > 0 && previousWorkcentreId && previousWorkcentreId !== operation.workcentreId) {
          const previousOperation = sortedOps[i - 1];
          if (!(previousOperation?.moveTime > 0)) {
            interOpGapMinutes = this.constraintManager?.getMovementTime(previousWorkcentreId, operation.workcentreId) ?? environment.defaultMovementTimeMinutes;
          }
        }

        const queueLagMinutes = context.ruleToggles?.useQueueTime === false
          ? 0
          : Math.max(0, operation.queueTime || 0);
        // Overlap: start once a share of the previous run is done, not at its end.
        // The previous op's own SYSPRO transfer wins over the company %.
        const prevOp = i > 0 ? sortedOps[i - 1] : undefined;
        const prevTransfer = context.ruleToggles?.useSysproTransfer ? prevOp?.transferFraction : undefined;
        const overlapFraction = validFraction(prevTransfer) ? prevTransfer : validFraction(globalOverlap) ? globalOverlap : undefined;
        const overlapping = overlapFraction !== undefined && !!previousSlot && !previousWasSubcontract && !operation.isSubcontract;
        let chainFromMs = predecessorEnd.getTime();
        if (overlapping && previousSlot) {
          const runMs = previousSlot.runEnd.getTime() - previousSlot.runStart.getTime();
          const moveMs = Math.max(0, previousSlot.moveEnd.getTime() - previousSlot.runEnd.getTime());
          chainFromMs = Math.min(chainFromMs, previousSlot.runStart.getTime() + overlapFraction! * runMs + moveMs);
        }
        // SYSPRO wait time after the previous op (elapsed, books no machine).
        const waitMinutes = context.ruleToggles?.useWaitTime && prevOp ? Math.max(0, prevOp.waitTime || 0) : 0;
        const earliestStart = new Date(chainFromMs + (interOpGapMinutes + queueLagMinutes + waitMinutes) * 60 * 1000);

        // Batch constraint check — warn if job quantity is below the operation's minimum batch size.
        if (this.constraintManager) {
          const batchCheck = this.constraintManager.canBatchOperations(operation, job.quantity, job.itemCode);
          if (!batchCheck.canBatch) {
            this.constraints.push({
              violationId: uuidv4(),
              type: 'BatchViolation',
              severity: 'Warning',
              affectedJobId: job.jobId,
              affectedOperationId: operation.opId,
              description: batchCheck.reason ?? `Job quantity ${job.quantity} does not meet minimum batch size for operation ${operation.opId}`,
              suggestedAction: 'Adjust job quantity or review batch size constraints'
            });
          }
        }

        // Check if this operation is pinned — if so, use its frozen slot directly.
        const pinKey = `${job.jobId}::${operation.opId}`;
        const pinnedSlot = context.pinnedOperations?.get(pinKey);

        let operationSlot: OperationSlot | null;
        let isPinned = false;

        if (pinnedSlot) {
          const pinStart = new Date(pinnedSlot.plannedStartDate);
          const pinEnd = new Date(pinnedSlot.plannedEndDate);
          if (!isNaN(pinStart.getTime()) && !isNaN(pinEnd.getTime()) && pinEnd > pinStart) {
            const durationMin = (pinEnd.getTime() - pinStart.getTime()) / 60000;
            operationSlot = {
              opId: operation.opId,
              jobId: job.jobId,
              workcentreId: pinnedSlot.workcentreId,
              start: pinStart,
              end: pinEnd,
              resourceId: pinnedSlot.resourceId,
              isOvertime: false,
              duration: durationMin,
              setupTime: operation.setupTime || 0,
              runTime: Math.max(0, durationMin - (operation.setupTime || 0)),
              queueTime: operation.queueTime || 0,
              moveTime: operation.moveTime || 0,
              setupStart: pinStart,
              setupEnd: new Date(pinStart.getTime() + (operation.setupTime || 0) * 60000),
              runStart: new Date(pinStart.getTime() + (operation.setupTime || 0) * 60000),
              runEnd: pinEnd,
              queueEnd: new Date(pinEnd.getTime() + (operation.queueTime || 0) * 60000),
              moveEnd: new Date(pinEnd.getTime() + ((operation.queueTime || 0) + (operation.moveTime || 0)) * 60000),
              capacityStart: pinStart,
              capacityEnd: pinEnd,
              sequence: operation.sequence,
            };
            isPinned = true;
          } else {
            // Pinned slot has invalid dates — fall back to normal scheduling
            operationSlot = this.findBestOperationSlot(operation, earliestStart, job, context, isFlowLine ? lockedLineGroupId : null);
          }
        } else if (operation.isSubcontract) {
          // Outside operation: elapsed time at the supplier, no internal capacity.
          operationSlot = this.buildSubcontractSlot(operation, job, earliestStart, 'forward');
        } else {
          // Find best time slot for this operation
          operationSlot = this.findBestOperationSlot(
            operation,
            earliestStart,
            job,
            context,
            isFlowLine ? lockedLineGroupId : null
          );
          // Overlap tail rule: the last transfer batch of the previous op
          // arrives at its move end; this op still needs a share of its own
          // run after that, so it cannot finish earlier. Push and retry.
          if (overlapping && previousSlot) {
            const ownRunMs = Math.max(0, (operation.duration || 0) * 60000);
            const requiredEndMs = previousSlot.moveEnd.getTime() + overlapFraction! * ownRunMs
              + waitMinutes * 60000;
            let startMs = earliestStart.getTime();
            for (let attempt = 0; attempt < 20 && operationSlot && operationSlot.runEnd.getTime() < requiredEndMs; attempt++) {
              startMs += requiredEndMs - operationSlot.runEnd.getTime();
              operationSlot = this.findBestOperationSlot(
                operation, new Date(startMs), job, context, isFlowLine ? lockedLineGroupId : null
              );
            }
            // Still finishing before the previous op's last batch arrives: keep
            // the slot (better than unscheduling) but say so.
            if (operationSlot && operationSlot.runEnd.getTime() < requiredEndMs) {
              const shortMin = Math.round((requiredEndMs - operationSlot.runEnd.getTime()) / 60000);
              this.constraints.push({
                violationId: uuidv4(),
                type: 'OverlapViolation',
                severity: 'Warning',
                affectedJobId: job.jobId,
                affectedOperationId: operation.opId,
                description: `Operation ${operation.opId} finishes ${shortMin} min before the last transfer batch from the previous operation can reach it (overlap rule not fully met)`,
                suggestedAction: 'Lower the overlap % for this routing, or move the operation later on the board',
              });
            }
          }
        }

        if (operationSlot) {
          // After placing the first op in flow-line mode, lock to its line group
          if (isFlowLine && lockedLineGroupId === null) {
            const resource = context.resources.get(operationSlot.resourceId);
            lockedLineGroupId = resource?.lineGroupId ?? null;
          }
          const why = !isPinned && !operation.isSubcontract
            ? this.explainWait(operation.workcentreId, operationSlot.resourceId, job.jobId, earliestStart, operationSlot.start)
            : undefined;
          operationSchedules.push({
            ...(why || {}),
            opId: operation.opId,
            workcentreId: operation.workcentreId,
            resourceId: operationSlot.resourceId,
            plannedStartDate: operationSlot.start,
            plannedEndDate: operationSlot.end,
            duration: operationSlot.duration,
            setupTime: operationSlot.setupTime,
            runTime: operationSlot.runTime,
            queueTime: operationSlot.queueTime,
            moveTime: operationSlot.moveTime,
            setupStart: operationSlot.setupStart,
            setupEnd: operationSlot.setupEnd,
            runStart: operationSlot.runStart,
            runEnd: operationSlot.runEnd,
            queueEnd: operationSlot.queueEnd,
            moveEnd: operationSlot.moveEnd,
            sequence: operation.sequence,
            isOvertimeSlot: operationSlot.isOvertime,
            batchSize: operation.batchSize,
            slackTime: this.calculateSlack(operationSlot.end, job.dueDate),
            opStatus: operation.status,
            pinned: isPinned || undefined,
          });

          // For pinned ops the slot was already pre-booked in prePlacePinnedOps;
          // only record it again if we found it via normal scheduling.
          if (!isPinned && !operation.isSubcontract) {
            operationSlot.itemCode = job.itemCode;
            this.recordOperationInLoads(operationSlot);
          }
          // Update sequence tracking so the next operation on this resource gets correct setup time.
          if (!operation.isSubcontract) this.lastItemPerResource.set(operationSlot.resourceId, job.itemCode);

          // Next operation can only start after the move time from this operation has elapsed
          if (operationSlot.end > context.planningHorizonEnd && !isPinned) {
            this.constraints.push({
              violationId: uuidv4(),
              type: 'ScheduleDateViolation',
              severity: 'Info',
              affectedJobId: job.jobId,
              affectedOperationId: operation.opId,
              description: `Operation ${operation.opId} (seq ${operation.sequence}) finishes after the planning window (${operationSlot.end.toISOString().slice(0, 10)})`,
              suggestedAction: 'Extend the planning window to see its full effect on this line',
            });
          }
          predecessorEnd = operationSlot.moveEnd;
          previousWorkcentreId = operation.workcentreId;
          previousSlot = operationSlot;
          previousWasSubcontract = !!operation.isSubcontract;
        } else {
          // Could not schedule this operation
          this.constraints.push({
            violationId: uuidv4(),
            type: 'CapacityExceeded',
            severity: 'Warning',
            affectedJobId: job.jobId,
            affectedOperationId: operation.opId,
            description: !context.workcentres.has(operation.workcentreId)
              ? `Operation ${operation.opId} (seq ${operation.sequence}) is routed to work centre ${operation.workcentreId}, which is not a production line or a machine on one in CRUX`
              : this.crewBlocked.has(operation.opId) && !this.crewTooSmall.has(operation.opId)
              ? (() => { const n = this.crewLoad?.needFor(operation.workcentreId); return `Operation ${operation.opId} (seq ${operation.sequence}) could not start inside the planning window: the ${n?.poolName} crew (${n?.headcount} operators) is busy on other lines the whole time`; })()
              : this.crewTooSmall.has(operation.opId)
              ? (() => { const n = this.crewLoad?.needFor(operation.workcentreId); return `Operation ${operation.opId} (seq ${operation.sequence}) needs ${n?.operators} operators on ${operation.workcentreId} but the ${n?.poolName} crew has only ${n?.headcount}`; })()
              : this.searchCapHit.has(operation.opId)
              ? `Could not find a slot for operation ${operation.opId} (seq ${operation.sequence}): search stopped after ${MAX_SLOT_ITERATIONS} attempts — the line is booked almost solid over the horizon`
              : this.beyondHorizon.has(operation.opId)
              ? `Operation ${operation.opId} (seq ${operation.sequence}) needs ${(((operation.setupTime || 0) + (operation.duration || 0)) / 60).toFixed(1)} h of machine time and would finish after the planning horizon ends`
              : `Could not find available slot for operation ${operation.opId} (seq ${operation.sequence})`,
            suggestedAction: !context.workcentres.has(operation.workcentreId)
              ? `Route the operation to a line in SYSPRO, or add ${operation.workcentreId} as a machine on a line (Manage → Machines)`
              : this.crewBlocked.has(operation.opId) && !this.crewTooSmall.has(operation.opId)
              ? 'Add operators to the crew, extend the planning window, or lower the priority of other jobs on its lines'
              : this.crewTooSmall.has(operation.opId)
              ? 'Raise the crew headcount or lower the operators needed on this line (Manage → Crews)'
              : this.searchCapHit.has(operation.opId)
              ? 'Extend the horizon, add shift time on this line, or move lower-priority jobs out'
              : this.beyondHorizon.has(operation.opId)
              ? 'Extend the planning horizon (week range) so the operation can finish inside it'
              : 'Increase resource capacity or delay non-critical jobs'
          });
          // Break the chain — can't schedule subsequent ops without predecessor completion
          break;
        }
      }

      const plannedStart = operationSchedules.length > 0 ? operationSchedules[0].plannedStartDate : job.releaseDate;
      // Latest op end (with overlap the last op is not guaranteed to end last).
      const plannedEnd = operationSchedules.length > 0
        ? operationSchedules.reduce((m, o) => (o.plannedEndDate > m ? o.plannedEndDate : m), operationSchedules[0].plannedEndDate)
        : job.dueDate;

      const tardiness = Math.max(
        0,
        (plannedEnd.getTime() - job.dueDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      return {
        jobId: job.jobId,
        plannedStartDate: plannedStart,
        plannedEndDate: plannedEnd,
        operationSchedules,
        estimatedTardiness: tardiness,
        status: operationSchedules.length === sortedOps.length ? 'Scheduled' : 'ConstraintViolation'
      };
    } catch (error) {
      logger.error({ err: error, jobId: job.jobId }, 'Error scheduling job');
      return {
        jobId: job.jobId,
        plannedStartDate: job.releaseDate,
        plannedEndDate: job.dueDate,
        operationSchedules: [],
        estimatedTardiness: 0,
        status: 'Unschedulable'
      };
    }
  }

  private async scheduleJobBackward(
    job: Job,
    context: SchedulingContext,
    /** Master-job precedence: the job must be finished by this instant. */
    latestEndOverride?: Date
  ): Promise<JobSchedule> {
    const reverseSchedules: OperationSchedule[] = [];
    let successorStart = job.dueDate < context.planningHorizonEnd
      ? job.dueDate
      : context.planningHorizonEnd;
    if (latestEndOverride && latestEndOverride < successorStart) {
      successorStart = latestEndOverride;
    }
    let nextWorkcentreId: string | null = null;

    // Flow-line: lock to line group from the *last* operation (scheduled first in backward pass).
    const effectiveModeBack: ProductionMode =
      (job.productionMode) ||
      (context.productionMode) ||
      'job-shop';
    const isFlowLineBack = effectiveModeBack === 'flow-line' ||
      (effectiveModeBack === 'mixed' && !!job.productionMode && job.productionMode === 'flow-line');
    let lockedLineGroupIdBack: string | null = null;

    const sortedOps = [...job.operations].sort((a, b) => a.sequence - b.sequence);

    try {
      // Same job-level material check as the forward path.
      const materialCheck = await this.checkMaterialAvailability(job, context);
      if (!materialCheck.available && context.ruleToggles?.enforceMaterial !== false) {
        return {
          jobId: job.jobId,
          plannedStartDate: job.releaseDate,
          plannedEndDate: job.dueDate,
          operationSchedules: [],
          estimatedTardiness: 0,
          status: 'ConstraintViolation'
        };
      }

      for (let i = sortedOps.length - 1; i >= 0; i--) {
        const operation = sortedOps[i];

        const successorOperation = i < sortedOps.length - 1 ? sortedOps[i + 1] : null;
        const successorQueueLag = context.ruleToggles?.useQueueTime === false
          ? 0
          : Math.max(0, successorOperation?.queueTime || 0);
        const transitionMinutes = (successorOperation && context.ruleToggles?.useMoveTime !== false)
          ? (operation.moveTime > 0
            ? operation.moveTime
            : (nextWorkcentreId && nextWorkcentreId !== operation.workcentreId ? (this.constraintManager?.getMovementTime(operation.workcentreId, nextWorkcentreId) ?? environment.defaultMovementTimeMinutes) : 0))
          : 0;

        const latestEnd = new Date(
          successorStart.getTime() - (successorQueueLag + transitionMinutes) * 60 * 1000
        );

        const operationSlot = operation.isSubcontract
          ? this.buildSubcontractSlot(operation, job, latestEnd, 'backward')
          : this.findBestOperationSlotBackward(
              operation,
              latestEnd,
              job,
              context,
              isFlowLineBack ? lockedLineGroupIdBack : null
            );

        if (operationSlot) {
          if (isFlowLineBack && lockedLineGroupIdBack === null) {
            const resource = context.resources.get(operationSlot.resourceId);
            lockedLineGroupIdBack = resource?.lineGroupId ?? null;
          }
          reverseSchedules.push({
            opId: operation.opId,
            workcentreId: operation.workcentreId,
            resourceId: operationSlot.resourceId,
            plannedStartDate: operationSlot.start,
            plannedEndDate: operationSlot.end,
            duration: operationSlot.duration,
            setupTime: operationSlot.setupTime,
            runTime: operationSlot.runTime,
            queueTime: operationSlot.queueTime,
            moveTime: operationSlot.moveTime,
            setupStart: operationSlot.setupStart,
            setupEnd: operationSlot.setupEnd,
            runStart: operationSlot.runStart,
            runEnd: operationSlot.runEnd,
            queueEnd: operationSlot.queueEnd,
            moveEnd: operationSlot.moveEnd,
            sequence: operation.sequence,
            isOvertimeSlot: operationSlot.isOvertime,
            batchSize: operation.batchSize,
            slackTime: this.calculateSlack(operationSlot.end, job.dueDate),
            opStatus: operation.status,
          });

          // Book the slot so later jobs see this capacity as taken. The backward
          // path never did this, so in backward mode jobs could overlap on a line.
          if (!operation.isSubcontract) {
            operationSlot.itemCode = job.itemCode;
            this.recordOperationInLoads(operationSlot);
            this.lastItemPerResource.set(operationSlot.resourceId, job.itemCode);
          }

          // Update successor tracking for the next backward iteration.
          successorStart = operationSlot.start;
          nextWorkcentreId = operation.workcentreId;
        } else {
          // Could not schedule this operation
          this.constraints.push({
            violationId: uuidv4(),
            type: 'CapacityExceeded',
            severity: 'Warning',
            affectedJobId: job.jobId,
            affectedOperationId: operation.opId,
            description: `Could not find available slot for operation ${operation.opId} (seq ${operation.sequence})`,
            suggestedAction: 'Increase resource capacity or delay non-critical jobs'
          });
          // Break backward chain — can't schedule preceding ops without successor placement.
          break;
        }
      }

      const operationSchedules = reverseSchedules.sort((a, b) => a.sequence - b.sequence);

      // Validate precedence: each op must finish before the next one starts.
      // Backward scheduling under constrained calendars can occasionally produce
      // a chain where op[i].end > op[i+1].start. Detect this, emit a Critical
      // violation, and fall back to forward scheduling for this job.
      for (let i = 0; i < operationSchedules.length - 1; i++) {
        if (operationSchedules[i].plannedEndDate > operationSchedules[i + 1].plannedStartDate) {
          this.constraints.push({
            violationId: uuidv4(),
            type: 'CapacityExceeded',
            severity: 'Critical',
            affectedJobId: job.jobId,
            affectedOperationId: operationSchedules[i].opId,
            description: `Backward scheduling produced a precedence violation: op ${operationSchedules[i].opId} (seq ${operationSchedules[i].sequence}) ends after op ${operationSchedules[i + 1].opId} (seq ${operationSchedules[i + 1].sequence}) starts. Falling back to forward scheduling.`,
            suggestedAction: 'The system has automatically retried using forward scheduling. Review capacity constraints.'
          });
          // Fall back to forward scheduling to guarantee a valid chain.
          return this.scheduleJob(job, context);
        }
      }

      const plannedStart = operationSchedules.length > 0 ? operationSchedules[0].plannedStartDate : job.releaseDate;
      const plannedEnd = operationSchedules.length > 0
        ? operationSchedules[operationSchedules.length - 1].plannedEndDate
        : job.dueDate;

      const tardiness = Math.max(
        0,
        (plannedEnd.getTime() - job.dueDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      return {
        jobId: job.jobId,
        plannedStartDate: plannedStart,
        plannedEndDate: plannedEnd,
        operationSchedules,
        estimatedTardiness: tardiness,
        status: operationSchedules.length === sortedOps.length ? 'Scheduled' : 'ConstraintViolation'
      };
    } catch (error) {
      logger.error({ err: error, jobId: job.jobId }, 'Error backward scheduling job');
      return {
        jobId: job.jobId,
        plannedStartDate: job.releaseDate,
        plannedEndDate: job.dueDate,
        operationSchedules: [],
        estimatedTardiness: 0,
        status: 'Unschedulable'
      };
    }
  }

  /** Apply company rule toggles: zero out disabled time components. */
  private applyRuleToggles(operation: Operation, context: SchedulingContext): Operation {
    const t = context.ruleToggles;
    if (!t || (t.useQueueTime !== false && t.useSetupTime !== false && t.useMoveTime !== false)) {
      return operation;
    }
    return {
      ...operation,
      queueTime: t.useQueueTime === false ? 0 : operation.queueTime,
      setupTime: t.useSetupTime === false ? 0 : operation.setupTime,
      moveTime: t.useMoveTime === false ? 0 : operation.moveTime,
    };
  }

  /**
   * Subcontract (outside) operation: occupies elapsed calendar time at the
   * supplier (SYSPRO ElapsedTime), including nights and weekends, and books no
   * internal machine or line. Falls back to setup + run minutes when no elapsed
   * time is recorded. Forward: starts at `anchor`. Backward: ends at `anchor`.
   */
  private buildSubcontractSlot(
    operation: Operation,
    job: Job,
    anchor: Date,
    direction: 'forward' | 'backward'
  ): OperationSlot {
    const minutes = Math.max(
      1,
      operation.elapsedMinutes ?? ((operation.setupTime || 0) + (operation.duration || 0))
    );
    const start = direction === 'forward' ? new Date(anchor) : new Date(anchor.getTime() - minutes * 60000);
    const end = new Date(start.getTime() + minutes * 60000);
    const moveMinutes = operation.moveTime || 0;
    return {
      opId: operation.opId,
      jobId: job.jobId,
      workcentreId: operation.workcentreId,
      start,
      end,
      resourceId: `SUB:${operation.subcontractSupplier || 'SUBCONTRACT'}`,
      isOvertime: false,
      duration: minutes,
      setupTime: 0,
      runTime: minutes,
      queueTime: operation.queueTime || 0,
      moveTime: moveMinutes,
      setupStart: start,
      setupEnd: start,
      runStart: start,
      runEnd: end,
      queueEnd: start,
      moveEnd: new Date(end.getTime() + moveMinutes * 60000),
      capacityStart: start,
      capacityEnd: end,
      sequence: operation.sequence,
      itemCode: job.itemCode,
    };
  }

  /** Item of the slot that finishes last at or before `time` on this workcentre (the op that really runs before it). */
  private predecessorItemAt(workcentreId: string, time: Date): string | undefined {
    const slots = this.workcentreLoads.get(workcentreId) || [];
    let best: OperationSlot | undefined;
    for (const s of slots) {
      if (s.capacityEnd <= time && (!best || s.capacityEnd > best.capacityEnd)) best = s;
    }
    return best?.itemCode;
  }

  /**
   * Why an operation starts later than it was ready: other jobs holding the
   * line or machine in [readyAt, start), and/or no productive shift time.
   * Must run before the op's own slot is recorded in the loads.
   */
  private explainWait(
    workcentreId: string, resourceId: string, jobId: string, readyAt: Date, start: Date
  ): { readyAt: Date; waitMinutes: number; waitReason?: 'line' | 'crew' | 'calendar' | 'mixed'; blockedBy?: string[] } {
    const waitMs = start.getTime() - readyAt.getTime();
    const waitMinutes = Math.max(0, Math.round(waitMs / 60000));
    if (waitMinutes < 1) return { readyAt, waitMinutes: 0 };
    const from = readyAt.getTime();
    const to = start.getTime();
    const busy: Array<[number, number]> = [];
    const blockers = new Set<string>();
    const scan = (slots: OperationSlot[] | undefined) => {
      for (const s of slots || []) {
        if (s.jobId === jobId) continue;
        const a = Math.max(from, s.capacityStart.getTime());
        const b = Math.min(to, s.capacityEnd.getTime());
        if (b > a) { busy.push([a, b]); blockers.add(s.jobId); }
      }
    };
    scan(this.workcentreLoads.get(workcentreId));
    scan(this.resourceLoads.get(resourceId));
    // Merge busy intervals to see how much of the wait the line explains.
    busy.sort((x, y) => x[0] - y[0]);
    let busyMs = 0; let curA = -1; let curB = -1;
    for (const [a, b] of busy) {
      if (a > curB) { if (curB > curA) busyMs += curB - curA; curA = a; curB = b; }
      else curB = Math.max(curB, b);
    }
    if (curB > curA) busyMs += curB - curA;
    const lineShare = busyMs / Math.max(1, waitMs);
    // Crew: other jobs holding the operators of this line's pool during the wait.
    const crewBlockers = lineShare >= 0.9 ? [] :
      (this.crewLoad?.overlapping(workcentreId, readyAt, start) ?? []).filter((b) => b.jobId !== jobId);
    for (const b of crewBlockers) blockers.add(b.jobId);
    const waitReason: 'line' | 'crew' | 'calendar' | 'mixed' =
      lineShare >= 0.9 ? 'line'
        : crewBlockers.length ? 'crew'
          : blockers.size === 0 ? 'calendar' : 'mixed';
    return {
      readyAt,
      waitMinutes,
      waitReason,
      blockedBy: blockers.size ? [...blockers].slice(0, 5) : undefined,
    };
  }

  /** Operation with its setup replaced by the changeover from `prevItemCode` (unchanged if none applies). */
  private withSequenceSetup(
    operation: Operation,
    job: Job,
    prevItemCode: string | undefined,
    context: SchedulingContext
  ): Operation {
    if (!this.constraintManager || context.ruleToggles?.useSetupTime === false) return operation;
    if (!prevItemCode) return operation;
    if (prevItemCode === job.itemCode) {
      // Same item back-to-back: no changeover when setup-once-per-group is on,
      // unless the matrix has an explicit same-item entry.
      if (!context.ruleToggles?.setupOncePerGroup) return operation;
      const explicit = this.constraintManager.getSequenceSetupTime(prevItemCode, job.itemCode, operation.workcentreId);
      // Matrix entry, else SYSPRO's minor setup, else none.
      const setup = explicit ?? operation.minorSetupTime ?? 0;
      return setup !== operation.setupTime ? { ...operation, setupTime: setup } : operation;
    }
    const seqDuration = this.constraintManager.calculateOperationDuration(operation, prevItemCode, job.itemCode);
    const adjustedSetup = Math.max(0, seqDuration - operation.duration - (operation.queueTime || 0));
    return adjustedSetup !== operation.setupTime ? { ...operation, setupTime: adjustedSetup } : operation;
  }

  /**
   * Sequence-dependent setup must be charged against the item that ACTUALLY
   * runs before the slot on the line — not simply the last item placed. When an
   * op back-fills an earlier gap those differ. First pass assumes the last item
   * placed; if the slot found has a different predecessor, recompute the
   * changeover for that predecessor and search once more.
   */
  private findSlotWithTruePredecessor(
    operation: Operation,
    job: Job,
    context: SchedulingContext,
    assumedPrev: string | undefined,
    search: (op: Operation) => OperationSlot | null
  ): OperationSlot | null {
    const firstOp = this.withSequenceSetup(operation, job, assumedPrev, context);
    const first = search(firstOp);
    if (!first || !this.constraintManager || context.ruleToggles?.useSetupTime === false) return first;
    const actualPrev = this.predecessorItemAt(operation.workcentreId, first.start);
    if (actualPrev === assumedPrev) return first;
    const secondOp = this.withSequenceSetup(operation, job, actualPrev, context);
    if (secondOp.setupTime === firstOp.setupTime) return first;
    return search(secondOp) || first;
  }

  private findBestOperationSlot(
    operation: Operation,
    earliestStart: Date,
    job: Job,
    context: SchedulingContext,
    requireLineGroupId: string | null = null
  ): OperationSlot | null {
    operation = this.applyRuleToggles(operation, context);
    const workcentre = context.workcentres.get(operation.workcentreId);
    if (!workcentre) return null;

    // Get qualified resources for this operation
    let qualifiedResources = Array.from(context.resources.values()).filter(
      (r) => r.worcentreId === operation.workcentreId &&
        r.status === 'Available' &&
        (operation.qualifiedResourceIds.length === 0 ||
          operation.qualifiedResourceIds.includes(r.resourceId))
    );

    const hasSkillConstraint = operation.qualifiedResourceIds.length > 0;
    if (qualifiedResources.length === 0) {
      qualifiedResources = Array.from(context.resources.values()).filter(
        (r) => r.worcentreId === operation.workcentreId && r.status === 'Available'
      );
      if (hasSkillConstraint && qualifiedResources.length > 0) {
        this.constraints.push({
          violationId: uuidv4(),
          type: 'SkillMismatch',
          severity: 'Warning',
          affectedJobId: job.jobId,
          affectedOperationId: operation.opId,
          description: `Operation ${operation.opId} on job ${job.jobId} has no qualified resource available; will assign from any available resource on workcentre ${operation.workcentreId}`,
          suggestedAction: 'Review operator skill assignments for this workcentre'
        });
      }
    }

    // Flow-line constraint: restrict to resources in the locked line group.
    if (requireLineGroupId !== null) {
      const inGroup = qualifiedResources.filter((r) => r.lineGroupId === requireLineGroupId);
      if (inGroup.length > 0) {
        qualifiedResources = inGroup;
      } else {
        // No resource in this group has the right workcentre — emit a warning
        // and fall through to any qualified resource so the schedule doesn't stall.
        this.constraints.push({
          violationId: uuidv4(),
          type: 'LineGroupViolation',
          severity: 'Warning',
          affectedJobId: job.jobId,
          affectedOperationId: operation.opId,
          description: `No resource in line group '${requireLineGroupId}' is available for operation ${operation.opId} (workcentre ${operation.workcentreId}). Falling back to any qualified resource.`,
          suggestedAction: `Ensure workcentre ${operation.workcentreId} has at least one resource assigned to line group '${requireLineGroupId}'`,
        });
      }
    }

    let bestSlot: OperationSlot | null = null;
    let bestSlackTime = Infinity;

    // Try to find earliest feasible slot for each resource
    for (const resource of qualifiedResources) {
      const resourceCapacity = Math.max(0, context.resourceCapacities?.get(resource.resourceId) ?? 1);
      if (resourceCapacity <= 0) {
        continue;
      }

      // Sequence-dependent setup (changeover) against the item that really runs
      // before this slot on the line. Skipped when useSetupTime = false.
      const slot = this.findSlotWithTruePredecessor(
        operation,
        job,
        context,
        this.lastItemPerResource.get(resource.resourceId),
        (op) => this.findFirstAvailableSlot(op, resource, workcentre, earliestStart, context.planningHorizonEnd, context)
      );

      if (slot) {
        // S3.5: reject slot if accepting it would breach the overtime budget for this
        // workcentre/day — the slot is skipped and the next resource is tried instead.
        if (slot.isOvertime) {
          const day = localDayKey(slot.start);
          const key = `${slot.workcentreId}|${day}`;
          const otHours = (slot.overtimeMinutes ?? 0) / 60;
          const existing = this.overtimeUsage.get(key) ?? 0;
          const budget = this.overtimeBudget.get(slot.workcentreId) ?? environment.maxOvertimePerDay;
          if (existing + otHours > budget) {
            continue;
          }
        }
        const slack = this.calculateSlack(slot.end, job.dueDate);
        if (slack < bestSlackTime) {
          bestSlackTime = slack;
          bestSlot = slot;
        }
      }
    }

    return bestSlot;
  }

  private findFirstAvailableSlot(
    operation: Operation,
    resource: Resource,
    workcentre: Workcentre,
    earliestStart: Date,
    horizonEnd: Date,
    context: SchedulingContext
  ): OperationSlot | null {
    const setupMinutes = operation.setupTime || 0;
    const runMinutes = operation.duration || 0;
    const queueMinutes = operation.queueTime || 0;
    const moveMinutes = operation.moveTime || 0;

    // A line that needs more operators than its whole crew has can never run.
    const crewNeed = this.crewLoad?.needFor(operation.workcentreId);
    if (crewNeed && crewNeed.operators > crewNeed.headcount) {
      this.crewTooSmall.add(operation.opId);
      return null;
    }

    // Only setup + run occupy the machine. Queue and move are timing constraints.
    const bookedMinutes = setupMinutes + runMinutes;

    const resourceSlots = overlapIndex(this.resourceLoads.get(resource.resourceId) || []);
    const workcentreSlots = overlapIndex(this.workcentreLoads.get(operation.workcentreId) || []);
    const resourceCapacity = Math.max(1, context.resourceCapacities?.get(resource.resourceId) ?? 1);
    const workcentreCapacity = Math.max(1, context.workcentreCapacities?.get(operation.workcentreId) ?? 1);

    let searchDate = new Date(earliestStart);
    const maxSearchDate = new Date(horizonEnd);
    if (
      maxSearchDate.getHours() === 0 &&
      maxSearchDate.getMinutes() === 0 &&
      maxSearchDate.getSeconds() === 0 &&
      maxSearchDate.getMilliseconds() === 0
    ) {
      maxSearchDate.setHours(23, 59, 59, 999);
    }

    const resourceCalendar: Cal = resource?.calendar || workcentre?.calendar;
    // Starts must fall inside the window; ends may run past it when allowed.
    const endLimit = context.ruleToggles?.allowFinishAfterHorizon
      ? new Date(maxSearchDate.getTime() + 366 * 86_400_000)
      : maxSearchDate;

    const isInWorkingWindow = (start: Date, end: Date): boolean => {
      return this.fitsProductiveWindow(start, end, resourceCalendar);
    };

    const nextWorkingDayStart = (date: Date): Date => {
      return this.nextProductiveStart(date, resourceCalendar) || new Date(date.getTime() + 24 * 60 * 60 * 1000);
    };

    // Capacity conflict checking uses the capacityStart/capacityEnd of existing slots
    let lastConflictWasCrew = false;
    const findNextConflictEnd = (candidateStart: Date, candidateEnd: Date): Date | null => {
      const overlappingResource = resourceSlots(candidateStart, candidateEnd);
      const overlappingWorkcentre = workcentreSlots(candidateStart, candidateEnd);

      const resourceBlocked = capacityFull(overlappingResource, candidateStart, candidateEnd, resourceCapacity);
      const workcentreBlocked = capacityFull(overlappingWorkcentre, candidateStart, candidateEnd, workcentreCapacity);
      // Crew: enough free operators in the line's pool for the whole booking?
      const crewNext = this.crewLoad?.nextFreeAt(operation.workcentreId, candidateStart, candidateEnd) ?? null;
      lastConflictWasCrew = !!crewNext && !resourceBlocked && !workcentreBlocked;

      if (!resourceBlocked && !workcentreBlocked && !crewNext) {
        return null;
      }

      let nextEnd: Date | null = crewNext;

      if (resourceBlocked) {
        for (const slot of overlappingResource) {
          if (!nextEnd || slot.capacityEnd < nextEnd) nextEnd = slot.capacityEnd;
        }
      }

      if (workcentreBlocked) {
        for (const slot of overlappingWorkcentre) {
          if (!nextEnd || slot.capacityEnd < nextEnd) nextEnd = slot.capacityEnd;
        }
      }

      return nextEnd;
    };

    let iterations = 0;

    while (searchDate <= maxSearchDate) {
      if (++iterations > MAX_SLOT_ITERATIONS) {
        logger.warn({ opId: operation.opId, resourceId: resource.resourceId, iterations: MAX_SLOT_ITERATIONS },
          'Slot search gave up after the iteration cap — operation left unscheduled');
        this.searchCapHit.add(operation.opId);
        break;
      }

      const nextStart = this.findContiguousProductiveStart(searchDate, setupMinutes, resourceCalendar)
        || this.nextProductiveStart(searchDate, resourceCalendar);
      if (!nextStart || nextStart > maxSearchDate) {
        break;
      }

      const setupStart = new Date(nextStart);
      const setupEnd = setupMinutes > 0
        ? new Date(setupStart.getTime() + setupMinutes * 60 * 1000)
        : new Date(setupStart);

      const setupWindowCheck = setupMinutes > 0
        ? setupEnd
        : new Date(setupStart.getTime() + 60000);

      if (!isInWorkingWindow(setupStart, setupWindowCheck)) {
        searchDate = nextWorkingDayStart(setupStart);
        continue;
      }

      const runStart = runMinutes > 0
        ? (this.nextProductiveStart(setupEnd, resourceCalendar) || new Date(setupEnd))
        : new Date(setupEnd);
      if (runStart > maxSearchDate) {
        break;
      }

      const runEnd = this.addMinutesAcrossProductiveWindows(runStart, runMinutes, resourceCalendar);
      if (!runEnd || runEnd > endLimit) {
        this.beyondHorizon.add(operation.opId);
        break;
      }

      const slotEnd = new Date(runEnd);
      const nextConflictEnd = findNextConflictEnd(setupStart, slotEnd);
      if (!nextConflictEnd) {
        const queueEnd = new Date(setupStart);
        const moveEnd = new Date(runEnd.getTime() + moveMinutes * 60 * 1000);

        // Determine overtime using the resource's actual calendar windows.
        // A slot is overtime if it starts after the first productive window
        // has ended (i.e. extended into a stretch shift) or runs past it.
        // When no window is defined at all for that day, treat the slot as
        // non-overtime — placing it on a day with no shift is already a
        // calendar violation and would have been rejected upstream; emitting
        // a spurious "overtime" flag here would just noise the metrics.
        // Overtime = the part of the booking that falls in "Overtime" shift
        // windows. (It used to be "runs past the first window of the start
        // day", so every multi-day operation counted as overtime in full and
        // was rejected against the 3 h/day budget — long jobs never scheduled.)
        const overtimeMinutes = this.overtimeMinutesIn(resourceCalendar, setupStart, runEnd);
        const isOvertime = overtimeMinutes > 0;

        return {
          opId: operation.opId,
          jobId: operation.jobId,
          workcentreId: operation.workcentreId,
          start: setupStart,
          end: runEnd,
          resourceId: resource.resourceId,
          isOvertime,
          overtimeMinutes,
          duration: bookedMinutes,
          setupTime: setupMinutes,
          runTime: runMinutes,
          queueTime: queueMinutes,
          moveTime: moveMinutes,
          setupStart,
          setupEnd,
          runStart,
          runEnd,
          queueEnd,
          moveEnd,
          capacityStart: setupStart,
          capacityEnd: runEnd,
          sequence: operation.sequence
        };
      }

      searchDate = new Date(Math.max(nextConflictEnd.getTime(), searchDate.getTime() + 60 * 1000));
    }

    if (lastConflictWasCrew) this.crewBlocked.add(operation.opId);
    return null;
  }

  private findBestOperationSlotBackward(
    operation: Operation,
    latestEnd: Date,
    job: Job,
    context: SchedulingContext,
    requireLineGroupId: string | null = null
  ): OperationSlot | null {
    operation = this.applyRuleToggles(operation, context);
    const workcentre = context.workcentres.get(operation.workcentreId);
    if (!workcentre) return null;

    let qualifiedResources = Array.from(context.resources.values()).filter(
      (r) => r.worcentreId === operation.workcentreId &&
        r.status === 'Available' &&
        (operation.qualifiedResourceIds.length === 0 ||
          operation.qualifiedResourceIds.includes(r.resourceId))
    );

    const hasSkillConstraintBack = operation.qualifiedResourceIds.length > 0;
    if (qualifiedResources.length === 0) {
      qualifiedResources = Array.from(context.resources.values()).filter(
        (r) => r.worcentreId === operation.workcentreId && r.status === 'Available'
      );
      if (hasSkillConstraintBack && qualifiedResources.length > 0) {
        this.constraints.push({
          violationId: uuidv4(),
          type: 'SkillMismatch',
          severity: 'Warning',
          affectedJobId: job.jobId,
          affectedOperationId: operation.opId,
          description: `Operation ${operation.opId} on job ${job.jobId} has no qualified resource available; will assign from any available resource on workcentre ${operation.workcentreId}`,
          suggestedAction: 'Review operator skill assignments for this workcentre'
        });
      }
    }

    // Flow-line constraint: restrict to resources in the locked line group.
    if (requireLineGroupId !== null) {
      const inGroup = qualifiedResources.filter((r) => r.lineGroupId === requireLineGroupId);
      if (inGroup.length > 0) {
        qualifiedResources = inGroup;
      } else {
        this.constraints.push({
          violationId: uuidv4(),
          type: 'LineGroupViolation',
          severity: 'Warning',
          affectedJobId: job.jobId,
          affectedOperationId: operation.opId,
          description: `No resource in line group '${requireLineGroupId}' is available for operation ${operation.opId} (workcentre ${operation.workcentreId}). Falling back to any qualified resource.`,
          suggestedAction: `Ensure workcentre ${operation.workcentreId} has at least one resource assigned to line group '${requireLineGroupId}'`,
        });
      }
    }

    let bestSlot: OperationSlot | null = null;
    let bestSlackTime = Infinity;

    for (const resource of qualifiedResources) {
      const resourceCapacity = Math.max(0, context.resourceCapacities?.get(resource.resourceId) ?? 1);
      if (resourceCapacity <= 0) {
        continue;
      }

      // Sequence-dependent setup (backward path) — same true-predecessor rule.
      const slot = this.findSlotWithTruePredecessor(
        operation,
        job,
        context,
        this.lastItemPerResource.get(resource.resourceId),
        (op) => this.findLastAvailableSlot(op, resource, workcentre, latestEnd, context.planningHorizonStart, context)
      );

      if (slot) {
        // S3.5: same overtime budget guard as the forward path.
        if (slot.isOvertime) {
          const day = localDayKey(slot.start);
          const key = `${slot.workcentreId}|${day}`;
          const otHours = (slot.overtimeMinutes ?? 0) / 60;
          const existing = this.overtimeUsage.get(key) ?? 0;
          const budget = this.overtimeBudget.get(slot.workcentreId) ?? environment.maxOvertimePerDay;
          if (existing + otHours > budget) {
            continue;
          }
        }
        const slack = this.calculateSlack(slot.end, job.dueDate);
        if (slack < bestSlackTime) {
          bestSlackTime = slack;
          bestSlot = slot;
        }
      }
    }

    return bestSlot;
  }

  private findLastAvailableSlot(
    operation: Operation,
    resource: Resource,
    workcentre: Workcentre,
    latestEnd: Date,
    horizonStart: Date,
    context: SchedulingContext
  ): OperationSlot | null {
    const setupMinutes = operation.setupTime || 0;
    const runMinutes = operation.duration || 0;
    const queueMinutes = operation.queueTime || 0;
    const moveMinutes = operation.moveTime || 0;
    const bookedMinutes = setupMinutes + runMinutes;

    const resourceSlots = overlapIndex(this.resourceLoads.get(resource.resourceId) || []);
    const workcentreSlots = overlapIndex(this.workcentreLoads.get(operation.workcentreId) || []);
    const resourceCapacity = Math.max(1, context.resourceCapacities?.get(resource.resourceId) ?? 1);
    const workcentreCapacity = Math.max(1, context.workcentreCapacities?.get(operation.workcentreId) ?? 1);

    let searchDate = new Date(latestEnd);
    const minSearchDate = new Date(horizonStart);
    minSearchDate.setHours(0, 0, 0, 0);

    const resourceCalendar: Cal = resource?.calendar || workcentre?.calendar;
    const isInWorkingWindow = (start: Date, end: Date): boolean => this.fitsProductiveWindow(start, end, resourceCalendar);

    const findPreviousConflictStart = (candidateStart: Date, candidateEnd: Date): Date | null => {
      const overlappingResource = resourceSlots(candidateStart, candidateEnd);
      const overlappingWorkcentre = workcentreSlots(candidateStart, candidateEnd);

      const resourceBlocked = capacityFull(overlappingResource, candidateStart, candidateEnd, resourceCapacity);
      const workcentreBlocked = capacityFull(overlappingWorkcentre, candidateStart, candidateEnd, workcentreCapacity);

      if (!resourceBlocked && !workcentreBlocked) {
        return null;
      }

      let previousStart: Date | null = null;

      if (resourceBlocked) {
        for (const slot of overlappingResource) {
          if (!previousStart || slot.capacityStart < previousStart) previousStart = slot.capacityStart;
        }
      }

      if (workcentreBlocked) {
        for (const slot of overlappingWorkcentre) {
          if (!previousStart || slot.capacityStart < previousStart) previousStart = slot.capacityStart;
        }
      }

      return previousStart;
    };

    let iterations = 0;

    while (searchDate >= minSearchDate) {
      if (++iterations > MAX_SLOT_ITERATIONS) {
        logger.warn({ opId: operation.opId, resourceId: resource.resourceId, iterations: MAX_SLOT_ITERATIONS },
          'Slot search gave up after the iteration cap — operation left unscheduled');
        this.searchCapHit.add(operation.opId);
        break;
      }

      const runEnd = this.previousProductiveEnd(searchDate, resourceCalendar) || new Date(searchDate);
      if (!runEnd || runEnd < minSearchDate) {
        break;
      }

      const runStart = runMinutes > 0
        ? this.subtractMinutesAcrossProductiveWindows(runEnd, runMinutes, resourceCalendar)
        : new Date(runEnd);
      if (!runStart || runStart < minSearchDate) {
        break;
      }

      const setupEnd = new Date(runStart);
      const setupStart = setupMinutes > 0
        ? this.subtractMinutesAcrossProductiveWindows(setupEnd, setupMinutes, resourceCalendar)
        : new Date(setupEnd);
      if (!setupStart || setupStart < minSearchDate) {
        break;
      }

      const setupWindowCheck = setupMinutes > 0 ? setupEnd : new Date(setupStart.getTime() + 60000);
      if (!isInWorkingWindow(setupStart, setupWindowCheck)) {
        searchDate = new Date(setupStart.getTime() - 60 * 1000);
        continue;
      }

      const previousConflictStart = findPreviousConflictStart(setupStart, runEnd);
      if (!previousConflictStart) {
        const queueEnd = new Date(setupStart);
        const moveEnd = new Date(runEnd.getTime() + moveMinutes * 60 * 1000);

        // Same calendar-aware overtime check as the forward slot finder.
        // When no productive window exists for the day the slot has already
        // been rejected by the working-window gate above, so emitting a
        // spurious overtime flag here would only add noise.
        // Overtime = the part of the booking that falls in "Overtime" shift
        // windows. (It used to be "runs past the first window of the start
        // day", so every multi-day operation counted as overtime in full and
        // was rejected against the 3 h/day budget — long jobs never scheduled.)
        const overtimeMinutes = this.overtimeMinutesIn(resourceCalendar, setupStart, runEnd);
        const isOvertime = overtimeMinutes > 0;

        return {
          opId: operation.opId,
          jobId: operation.jobId,
          workcentreId: operation.workcentreId,
          start: setupStart,
          end: runEnd,
          resourceId: resource.resourceId,
          isOvertime,
          overtimeMinutes,
          duration: bookedMinutes,
          setupTime: setupMinutes,
          runTime: runMinutes,
          queueTime: queueMinutes,
          moveTime: moveMinutes,
          setupStart,
          setupEnd,
          runStart,
          runEnd,
          queueEnd,
          moveEnd,
          capacityStart: setupStart,
          capacityEnd: runEnd,
          sequence: operation.sequence
        };
      }

      searchDate = new Date(previousConflictStart.getTime() - 60 * 1000);
    }

    return null;
  }

  private recordOperationInLoads(slot: OperationSlot): void {
    this.crewLoad?.book(slot.workcentreId, slot.capacityStart, slot.capacityEnd, slot.jobId);
    const resourceSlots = this.resourceLoads.get(slot.resourceId) || [];
    resourceSlots.push(slot);
    resourceSlots.sort((a, b) => a.capacityStart.getTime() - b.capacityStart.getTime());
    this.resourceLoads.set(slot.resourceId, resourceSlots);

    const workcentreSlots = this.workcentreLoads.get(slot.workcentreId) || [];
    workcentreSlots.push(slot);
    workcentreSlots.sort((a, b) => a.capacityStart.getTime() - b.capacityStart.getTime());
    this.workcentreLoads.set(slot.workcentreId, workcentreSlots);

    // Tally overtime for this workcentre/day. We don't reject the placement
    // (the slot was already chosen) but we surface a Warning the first time
    // the daily overtime budget is exceeded so the planner can react.
    if (slot.isOvertime) {
      const day = localDayKey(slot.capacityStart);
      const key = `${slot.workcentreId}|${day}`;
      const otHours = (slot.overtimeMinutes ?? 0) / 60;
      const total = (this.overtimeUsage.get(key) || 0) + otHours;
      this.overtimeUsage.set(key, total);

      const budget =
        this.overtimeBudget.get(slot.workcentreId) ?? environment.maxOvertimePerDay;
      if (total > budget && !this.overtimeFlagged.has(key)) {
        this.overtimeFlagged.add(key);
        this.constraints.push({
          violationId: uuidv4(),
          type: 'OvertimeExceeded',
          severity: 'Warning',
          affectedJobId: slot.jobId,
          affectedOperationId: slot.opId,
          description:
            `Workcentre ${slot.workcentreId} overtime on ${day}: ` +
            `${total.toFixed(2)}h scheduled vs ${budget.toFixed(2)}h budget ` +
            `(${(total - budget).toFixed(2)}h over).`,
          suggestedAction:
            'Move the offending operation earlier, raise the overtime budget, or add a parallel resource.',
        });
      }
    }
  }

  private calculateSlack(endDate: Date, dueDate: Date): number {
    return Math.max(0, (dueDate.getTime() - endDate.getTime()) / (1000 * 60));
  }

  /**
   * Real material availability check, replacing the prior always-true stub.
   *
   * Reads from `context.materialPlan` (built once per schedule run by the
   * /generate route via SysproDatabaseService.getJobMaterialPlans). When
   * a job has shortages, emits one Critical ConstraintViolation per
   * shortage — UI can render those in the Constraints tab and link back
   * to the BOM modal.
   *
   * If no plan was supplied (older callers, unit tests) the check passes
   * silently, preserving prior behaviour.
   */
  private async checkMaterialAvailability(
    job: Job,
    context: SchedulingContext
  ): Promise<{ available: boolean; missingMaterial?: string }> {
    const plan = context.materialPlan?.get(String(job.jobId));
    if (!plan) {
      // Caller didn't supply a plan — treat as available, no warning.
      return { available: true };
    }

    if (plan.available) {
      return { available: true };
    }

    // Surface every shortage line as its own violation so the planner can
    // see exactly what's blocking the job, not just "material shortage".
    for (const shortage of plan.shortages) {
      const dedupeKey = `${job.jobId}|${shortage.componentCode}`;
      if (this.materialViolationsSeen.has(dedupeKey)) continue;
      this.materialViolationsSeen.add(dedupeKey);

      const uom = shortage.unitOfMeasure ? ` ${shortage.unitOfMeasure}` : '';
      this.constraints.push({
        violationId: uuidv4(),
        type: 'MaterialShortage',
        severity: plan.status === 'No Materials' ? 'Critical' : 'Warning',
        affectedJobId: job.jobId,
        description:
          `Component ${shortage.componentCode}: ` +
          `need ${shortage.requiredQty.toFixed(2)}${uom}, ` +
          `available ${shortage.availableQty.toFixed(2)}${uom}, ` +
          `short ${shortage.shortageQty.toFixed(2)}${uom}`,
        suggestedAction:
          plan.status === 'No Materials'
            ? 'Block the job until a PO arrives, or expedite procurement.'
            : 'Run a partial batch or split the job to match available stock.',
      });
    }

    return {
      available: false,
      missingMaterial: plan.shortages.map((s) => s.componentCode).join(', '),
    };
  }

  private buildResourceLoads(context: SchedulingContext): ResourceLoad[] {
    const loads: ResourceLoad[] = [];

    context.resources.forEach((resource) => {
      const slots = this.resourceLoads.get(resource.resourceId) || [];
      const dayLoads = new Map<string, { regular: number; overtime: number }>();

      const calendar: Cal = resource.calendar
        || context.workcentres.get(resource.worcentreId)?.calendar;

      // Spread each booking over the days it actually runs (a 50 h operation
      // used to be credited in full to its start day).
      slots.forEach((slot) => {
        const byDay = this.occupiedMinutesByDay(calendar, slot.capacityStart, slot.capacityEnd);
        if (byDay.size === 0) {
          byDay.set(localDayKey(slot.capacityStart), {
            regular: (slot.capacityEnd.getTime() - slot.capacityStart.getTime()) / 60000, overtime: 0,
          });
        }
        byDay.forEach((mins, key) => {
          const [y, m, d] = key.split('-').map(Number);
          const dayKey = new Date(y, m - 1, d).toDateString();
          if (!dayLoads.has(dayKey)) dayLoads.set(dayKey, { regular: 0, overtime: 0 });
          const load = dayLoads.get(dayKey)!;
          load.regular += mins.regular / 60;
          load.overtime += mins.overtime / 60;
        });
      });
      dayLoads.forEach((load, dayKey) => {
        const date = new Date(dayKey);
        // Utilization against that day's actual shift hours (was a hardcoded 8 h).
        const availableHours = this.productiveHoursForDay(calendar, date);
        loads.push({
          resourceId: resource.resourceId,
          date,
          regularHours: load.regular,
          overtimeHours: load.overtime,
          utilizationRate: availableHours > 0 ? Math.min(100, (load.regular / availableHours) * 100) : 0,
          assignedOperations: slots.filter((s) => s.start.toDateString() === dayKey) as unknown as ResourceLoad['assignedOperations']
        });
      });
    });

    return loads;
  }

  /**
   * Productive minutes a booking [from, to) actually occupies, per local day,
   * split into regular and overtime (windows from "Overtime" diversions).
   * A multi-day operation is spread over the days it runs, and the gaps
   * between shifts are not counted.
   */
  private occupiedMinutesByDay(calendar: Cal, from: Date, to: Date): Map<string, { regular: number; overtime: number }> {
    const out = new Map<string, { regular: number; overtime: number }>();
    if (!(to > from)) return out;
    const day = new Date(from);
    day.setHours(0, 0, 0, 0);
    for (let i = 0; i < 400 && day < to; i++) {
      for (const w of this.getProductiveWindowsForDay(calendar, day)) {
        const ms = Math.min(w.end.getTime(), to.getTime()) - Math.max(w.start.getTime(), from.getTime());
        if (ms <= 0) continue;
        const key = localDayKey(day);
        const entry = out.get(key) ?? { regular: 0, overtime: 0 };
        if (w.overtime) entry.overtime += ms / 60000; else entry.regular += ms / 60000;
        out.set(key, entry);
      }
      day.setDate(day.getDate() + 1);
    }
    return out;
  }

  /** Minutes of a booking that fall in overtime windows. */
  private overtimeMinutesIn(calendar: Cal, from: Date, to: Date): number {
    let total = 0;
    this.occupiedMinutesByDay(calendar, from, to).forEach((v) => { total += v.overtime; });
    return total;
  }

  /** Shift hours available on one day for a calendar (sum of productive windows). */
  private productiveHoursForDay(calendar: Cal, date: Date): number {
    return this.getProductiveWindowsForDay(calendar, date)
      .reduce((h, w) => h + (w.end.getTime() - w.start.getTime()) / 3600000, 0);
  }

  /**
   * Time model per workcentre over the planning horizon (LYNQ definitions):
   *   operating = shift hours; busy = setup + run booked; productive = run;
   *   direct downtime = setup/changeover; idle = operating − busy (≥ 0).
   * A workcentre (line) runs one operation at a time, so it is the unit of
   * capacity; its calendar is taken from its first resource.
   */
  private computeTimeModel(context: SchedulingContext) {
    const start = new Date(context.planningHorizonStart);
    start.setHours(0, 0, 0, 0);
    const end = new Date(context.planningHorizonEnd);

    const calendarByWc = new Map<string, Cal>();
    context.resources.forEach((r) => {
      if (!calendarByWc.has(r.worcentreId)) {
        calendarByWc.set(r.worcentreId, r.calendar || context.workcentres.get(r.worcentreId)?.calendar);
      }
    });

    let operating = 0, busy = 0, productive = 0, setup = 0;
    for (const [wcId, calendar] of calendarByWc) {
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        operating += this.productiveHoursForDay(calendar, d);
      }
      for (const slot of this.workcentreLoads.get(wcId) || []) {
        if (slot.capacityEnd <= context.planningHorizonStart || slot.capacityStart >= end) continue;
        productive += (slot.runTime || 0) / 60;
        setup += (slot.setupTime || 0) / 60;
      }
    }
    busy = productive + setup;
    const idle = Math.max(0, operating - busy);
    const pct = (h: number) => (operating > 0 ? Math.round((h / operating) * 1000) / 10 : 0);
    const r1 = (h: number) => Math.round(h * 10) / 10;
    return {
      operatingHours: r1(operating),
      busyHours: r1(busy),
      productiveHours: r1(productive),
      directDowntimeHours: r1(setup),
      idleHours: r1(idle),
      busyPct: pct(busy),
      productivePct: pct(productive),
      directDowntimePct: pct(setup),
      idlePct: pct(idle),
    };
  }

  private calculateMetrics(
    jobSchedules: JobSchedule[],
    resourceLoads: ResourceLoad[],
    context: SchedulingContext
  ): ScheduleMetrics {
    const scheduledJobs = jobSchedules.filter((j) => j.status === 'Scheduled');
    const onTimeJobs = scheduledJobs.filter((j) => j.estimatedTardiness === 0);
    const tardyJobs = scheduledJobs.filter((j) => j.estimatedTardiness > 0);

    const totalOvertime = resourceLoads.reduce((acc, load) => acc + load.overtimeHours, 0);
    const timeModel = this.computeTimeModel(context);

    let totalSetupMinutes = 0;
    let totalQueueMinutes = 0;
    let totalMoveMinutes = 0;
    for (const job of jobSchedules) {
      for (const op of job.operationSchedules) {
        totalSetupMinutes += op.setupTime || 0;
        totalQueueMinutes += op.queueTime || 0;
        totalMoveMinutes += op.moveTime || 0;
      }
    }

    const leadTimes = scheduledJobs
      .map((j) => (new Date(j.plannedEndDate).getTime() - new Date(j.plannedStartDate).getTime()) / 86400000)
      .filter((d) => Number.isFinite(d) && d >= 0);

    return {
      // Only fully scheduled jobs (unscheduled ones used to be counted too).
      totalJobsScheduled: scheduledJobs.length,
      jobsOnTime: onTimeJobs.length,
      jobsTardy: tardyJobs.length,
      averageTardiness:
        tardyJobs.length > 0
          ? tardyJobs.reduce((acc, j) => acc + j.estimatedTardiness, 0) / tardyJobs.length
          : 0,
      // Busy ÷ operating hours. It was regular ÷ (regular + overtime), which is
      // ~100 % almost always and skewed the rule optimizer's ranking.
      resourceUtilization: timeModel.busyPct,
      overtimeHours: totalOvertime,
      criticalPathLength: jobSchedules.reduce((acc: number, job) => {
        const jobDuration = job.operationSchedules.reduce(
          (opAcc: number, op) => opAcc + (op.duration || 0) / 60,
          0
        );
        return Math.max(acc, jobDuration);
      }, 0),
      totalSetupTime: totalSetupMinutes / 60,
      totalQueueTime: totalQueueMinutes / 60,
      totalMoveTime: totalMoveMinutes / 60,
      ...timeModel,
      otdRate: scheduledJobs.length > 0 ? Math.round((onTimeJobs.length / scheduledJobs.length) * 1000) / 10 : 0,
      avgLeadTimeDays: leadTimes.length
        ? Math.round((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) * 10) / 10
        : 0,
      jobsUnscheduled: jobSchedules.length - scheduledJobs.length,
    };
  }
}

export default SchedulingEngine;
