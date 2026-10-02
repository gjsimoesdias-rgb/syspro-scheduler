/**
 * Manual scheduling on the board — drag a job or operation onto a line,
 * auto-schedule a single job/op, schedule around a job, move ops with
 * precedence and calendar rules, and the job context-menu commands.
 * Moved verbatim from App.tsx (App.tsx split, slice 2); App passes the state
 * and actions it owns through `ctx`.
 */
import React from 'react';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { Schedule, Job, JobSchedule, OperationSchedule, Resource } from '../types';
import { resourceService } from '../services/api';
import { convertScheduleDates } from '../utils/scheduleDates';
import { findEarliestSlotOrForce, findEarliestSlotWithRetry } from '../utils/slotFinder';
import { clampMasterDropStart, describeDependencyViolation } from '../utils/masterSub';
import {
  alignToProductiveWindow as alignToProductiveWindowUtil,
  calculateProductiveEndMs as calculateProductiveEndMsUtil,
  type CalendarWindowEnv,
} from '../utils/calendarWindows';
import { useScheduleStore } from '../stores/scheduleStore';
import type { ContentTab, ManageTab, ScheduleAroundMode } from '../stores/uiStore';
import type { UndoRedoManager } from '../services/undoRedoManager';
import type { AlternativeGroup } from './useJobsData';

export interface JobContextMenuState { visible: boolean; x: number; y: number; jobId: string | null }

export interface ManualSchedulingContext {
  schedule: Schedule | null;
  setSchedule: (s: Schedule | null) => void;
  openJobs: Job[];
  visibleJobSource: Job[];
  resources: Resource[];
  alternativeGroups: AlternativeGroup[];
  undoRedoManager: UndoRedoManager;
  markScheduleEdited: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  exportToSyspro: () => Promise<void>;
  loadJobsAndResources: () => Promise<void>;
  openScheduleSetup: (preselect?: string[]) => void;
  masterParentMap: Map<string, string>;
  getMasterRootJobId: (job: Job) => string;
  boardIntervalStart: string;
  boardIntervalEnd: string;
  schedulingHorizon: { start: string; end: string };
  scheduleAroundMode: ScheduleAroundMode;
  highlightJobId: string | null;
  setHighlightJobId: (id: string | null) => void;
  jobContextMenu: JobContextMenuState;
  setJobContextMenu: React.Dispatch<React.SetStateAction<JobContextMenuState>>;
  setExpandedJobs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  toggleJobExpanded: (jobId: string) => void;
  /** Flip a job's Pin / Exclude flag on the server (applies to every run). */
  toggleJobFlag: (jobId: string, flag: 'excluded' | 'pinned') => Promise<void>;
  setSelectedWorkcentre: React.Dispatch<React.SetStateAction<string[]>>;
  setGanttFocusWorkcentre: React.Dispatch<React.SetStateAction<string | string[] | null>>;
  setContentTab: (v: ContentTab) => void;
  setManageTab: (v: ManageTab) => void;
  scheduleOpRef: React.MutableRefObject<((job: Job, opId: string) => Promise<void>) | null>;
  operationMoveRef: React.MutableRefObject<((jobId: string, opId: string, newStart: Date, wc: string) => void) | null>;
}

export function useManualScheduling(ctx: ManualSchedulingContext) {
  const {
    schedule,
    setSchedule,
    openJobs,
    visibleJobSource,
    resources,
    alternativeGroups,
    undoRedoManager,
    markScheduleEdited,
    handleUndo,
    handleRedo,
    exportToSyspro,
    loadJobsAndResources,
    openScheduleSetup,
    masterParentMap,
    getMasterRootJobId,
    boardIntervalStart,
    boardIntervalEnd,
    schedulingHorizon,
    scheduleAroundMode,
    highlightJobId,
    setHighlightJobId,
    jobContextMenu,
    setJobContextMenu,
    setExpandedJobs,
    toggleJobExpanded,
    toggleJobFlag,
    setSelectedWorkcentre,
    setGanttFocusWorkcentre,
    setContentTab,
    setManageTab,
    scheduleOpRef,
    operationMoveRef,
  } = ctx;

  const getCalendarForWorkcentre = (workcentreId: string) => {
    return resources.find((resource) => resource.worcentreId === workcentreId || resource.resourceId === workcentreId)?.calendar;
  };

  const getSchedulingHorizonBounds = (override?: { start: string; end: string }) => {
    const startValue = override?.start || schedulingHorizon.start;
    const endValue = override?.end || schedulingHorizon.end;
    const startDate = new Date(`${startValue}T00:00:00`);
    const endDate = new Date(`${endValue}T23:59:59.999`);
    return {
      startDate,
      endDate,
      startMs: startDate.getTime(),
      endMs: endDate.getTime()
    };
  };

  // Productive-window math extracted to utils/calendarWindows.ts (unit-tested).
  // These wrappers bind the App's calendar lookup + current horizon bounds.
  const calendarWindowEnv = (): CalendarWindowEnv => {
    const { startMs, endMs } = getSchedulingHorizonBounds();
    return { getCalendar: getCalendarForWorkcentre, horizonStartMs: startMs, horizonEndMs: endMs };
  };

  const alignToProductiveWindow = (candidateMs: number, _bookedMs: number, workcentreId: string): number =>
    alignToProductiveWindowUtil(calendarWindowEnv(), candidateMs, workcentreId);

  const calculateProductiveEndMs = (startMs: number, bookedMs: number, workcentreId: string): number =>
    calculateProductiveEndMsUtil(calendarWindowEnv(), startMs, bookedMs, workcentreId);

  const autoScheduleDroppedJob = async (jobId: string, dropDate: Date, droppedOnWorkcentre: string, machineId?: string) => {
    try {
      const job = openJobs.find((j) => j.jobId === jobId);
      if (!job) {
        toast.error('Job not found in production list');
        return;
      }
      if (!job.operations?.length) {
        toast.error('Selected job has no operations to schedule');
        return;
      }

      const definitionsResponse = await resourceService.getDefinitions().catch(() => ({ definitions: [] as any[] }));
      const quantityByWorkcentre: Record<string, number> = {};
      for (const definition of definitionsResponse.definitions || []) {
        const wc = String(definition.workcentreId || '');
        if (!wc) continue;
        if (definition.activated === false) continue;
        const qty = Math.max(1, Number(definition.quantity || 1));
        quantityByWorkcentre[wc] = (quantityByWorkcentre[wc] || 0) + qty;
      }

      const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
      // Master/sub dependency guard (mirrors the engine rule): a master job may
      // not start before its already-scheduled sub-jobs finish. Clamp the drop
      // time forward and tell the planner instead of silently violating it.
      let dropMs = new Date(dropDate).getTime();
      const masterClamp = clampMasterDropStart(jobId, dropMs, masterParentMap, schedule);
      if (masterClamp.blockingSubJobId) {
        dropMs = masterClamp.clampedStartMs + 60_000;
        toast(
          `${jobId} is a master job — start moved to after sub-job ${masterClamp.blockingSubJobId} finishes (${new Date(dropMs).toLocaleString()})`,
          { icon: 'ℹ️', duration: 6000 }
        );
      }
      // If the user drops past the planning horizon, extend the effective window to
      // cover the drop position + 90-day buffer. The horizon is a guide, not a wall.
      if (dropMs > horizonBounds.endMs) {
        horizonBounds.endMs = dropMs + 90 * 24 * 60 * 60 * 1000;
        horizonBounds.endDate = new Date(horizonBounds.endMs);
      }
      const baselineStart = new Date(Math.max(dropMs, horizonBounds.startMs));

      const baseSchedule: Schedule = schedule
        ? convertScheduleDates(schedule)
        : {
            scheduleId: `manual-${Date.now()}`,
            scheduledDate: new Date(),
            version: 1,
            status: 'Draft',
            planningHorizon: {
              startDate: horizonBounds.startDate,
              endDate: horizonBounds.endDate
            },
            jobSchedules: [],
            resourceLoads: [],
            constraintViolations: [],
            metrics: {
              totalJobsScheduled: 0,
              jobsOnTime: 0,
              jobsTardy: 0,
              averageTardiness: 0,
              resourceUtilization: 0,
              overtimeHours: 0,
              criticalPathLength: 0,
              totalSetupTime: 0,
              totalQueueTime: 0,
              totalMoveTime: 0
            }
          };

      type Interval = { start: number; end: number };
      const intervalsByWorkcentre = new Map<string, Interval[]>();

      for (const js of baseSchedule.jobSchedules) {
        if (js.jobId === job.jobId) continue;
        for (const op of js.operationSchedules) {
          const key = op.workcentreId;
          if (!intervalsByWorkcentre.has(key)) {
            intervalsByWorkcentre.set(key, []);
          }
          intervalsByWorkcentre.get(key)!.push({
            start: new Date(op.plannedStartDate).getTime(),
            end: new Date(op.plannedEndDate).getTime()
          });
        }
      }

      // Slot maths extracted to utils/slotFinder.ts (unit-tested; behaviour
      // preserved — the old inline "re-insert candidate" branch was dead code
      // because every relevant interval end is pre-seeded as a candidate).
      const findEarliestSlot = (
        desiredStartMs: number,
        durationMs: number,
        intervals: Interval[],
        capacity: number,
        workcentreId: string
      ): number | null =>
        findEarliestSlotWithRetry({
          desiredStartMs,
          durationMs,
          intervals,
          capacity,
          workcentreId,
          horizonStartMs: horizonBounds.startMs,
          horizonEndMs: horizonBounds.endMs,
          adapters: { align: alignToProductiveWindow, productiveEnd: calculateProductiveEndMs },
          onForcedPlacement: (wc) =>
            toast(`⚠ ${wc}: no free calendar slot found — job placed outside normal shift hours`, { icon: '⚠️' }),
        });

      const sortedOps = job.operations.slice().sort((a, b) => a.sequence - b.sequence);

      // Find the first op that runs on the dropped workcentre — this is the "anchor".
      // The anchor op should start as close to the drop time as possible.
      // Preceding ops (before the anchor) are back-scheduled so they finish by the drop time.
      const anchorIdx = (() => {
        const idx = sortedOps.findIndex(op => (op.workcentreId || droppedOnWorkcentre) === droppedOnWorkcentre);
        return idx >= 0 ? idx : 0; // fallback: treat op0 as anchor if none match
      })();

      // Estimate wall-clock duration of ops BEFORE the anchor (raw minutes, no calendar).
      // This lets us start the chain early enough for the anchor to land at the drop time.
      let estimatedPrecedingMs = 0;
      for (let i = 0; i < anchorIdx; i++) {
        const op = sortedOps[i];
        estimatedPrecedingMs += (
          Math.max(0, Number(op.queueTime) || 0) +
          Math.max(0, Number(op.setupTime) || 0) +
          Math.max(1, Number(op.duration) || 1) +
          Math.max(0, Number(op.moveTime) || 0)
        ) * 60 * 1000;
      }

      // Start the chain early enough that preceding ops can finish by the drop time.
      const chainStartMs = Math.max(horizonBounds.startMs, baselineStart.getTime() - estimatedPrecedingMs);
      let precedenceCursorMs = chainStartMs;
      const operationSchedules: OperationSchedule[] = [];

      for (const [index, op] of sortedOps.entries()) {
        const durationMinutes = Math.max(Number(op.duration) || 1, 1);
        const setupMinutes = Math.max(Number(op.setupTime) || 0, 0);
        const queueMinutes = Math.max(Number(op.queueTime) || 0, 0);
        const moveMinutes = Math.max(Number(op.moveTime) || 0, 0);
        const bookedMinutes = setupMinutes + durationMinutes;
        const durationMs = bookedMinutes * 60 * 1000;

        const wc = op.workcentreId || droppedOnWorkcentre;
        const capacity = 1; // one operation at a time per production line
        const intervals = intervalsByWorkcentre.get(wc) || [];
        const alternativeMachines = alternativeGroups
          .filter((group) => group.workcentreId === wc)
          .flatMap((group) => group.machineIds || []);
        const candidateMachines = Array.from(new Set([...(op.qualifiedResourceIds || []), ...alternativeMachines].filter(Boolean)));
        // Fallback machine: prefer the dropped machine (for ops on the dropped WC),
        // then the first qualified resource, then the workcentre ID itself.
        // Using the workcentre ID as the resourceId would make the bar invisible in
        // machine-lane rendering (lanes are keyed by resourceId, not worcentreId).
        const fallbackMachine = (machineId && wc === droppedOnWorkcentre) ? machineId : wc;
        // The user dropped the job on a SPECIFIC machine lane. The anchor
        // operation (the one whose workcentre matches the dropped lane) must
        // land on that exact machine — otherwise the bar appears in a
        // different lane (or, if the chosen qualified resource isn't a
        // rendered lane, nowhere at all), which looks like the drop failed.
        // Non-anchor operations keep the qualified-resource rotation so that
        // a multi-op job still spreads across its qualified machines.
        const isAnchorOp = index === anchorIdx;
        const droppedMachinePreferred = isAnchorOp && machineId && wc === droppedOnWorkcentre;
        const assignedMachine = droppedMachinePreferred
          ? machineId
          : (candidateMachines[index % Math.max(1, candidateMachines.length)] || fallbackMachine);

        // Compute desired start:
        // - For the anchor op, honour the drop time as the minimum (the op lands where dropped, or next free slot).
        // - For preceding ops, chain from chainStartMs so they finish in time for the anchor.
        // - For ops after the anchor, chain sequentially from the previous op's end.
        const arrivalMs = index === 0 ? chainStartMs : precedenceCursorMs;
        const effectiveArrivalMs = index === anchorIdx
          ? Math.max(arrivalMs, baselineStart.getTime())
          : arrivalMs;
        const desiredStartMs = effectiveArrivalMs + queueMinutes * 60000;

        const startMs = findEarliestSlot(desiredStartMs, durationMs, intervals, capacity, wc);
        if (startMs === null) {
          toast.error(`Job ${job.jobId} cannot fit within the selected Start and End dates`);
          return;
        }
        const endMs = calculateProductiveEndMs(startMs, durationMs, wc);

        intervals.push({ start: startMs, end: endMs });
        intervalsByWorkcentre.set(wc, intervals);

        const setupStart = new Date(startMs);
        const setupEndMs = calculateProductiveEndMs(startMs, setupMinutes * 60000, wc);
        const setupEnd = new Date(setupEndMs);
        const runStart = new Date(setupEndMs);
        const runEndMs = calculateProductiveEndMs(setupEndMs, durationMinutes * 60000, wc);
        const runEnd = new Date(runEndMs);
        const queueEndDate = new Date(setupStart.getTime());
        const moveEndDate = new Date(runEndMs + moveMinutes * 60000);
        precedenceCursorMs = moveEndDate.getTime();

        operationSchedules.push({
          opId: String(op.opId),
          workcentreId: wc,
          resourceId: assignedMachine,
          plannedStartDate: new Date(startMs),
          plannedEndDate: new Date(endMs),
          duration: bookedMinutes,
          setupTime: setupMinutes,
          runTime: durationMinutes,
          queueTime: queueMinutes,
          moveTime: moveMinutes,
          setupStart,
          setupEnd,
          runStart,
          runEnd,
          queueEnd: queueEndDate,
          moveEnd: moveEndDate,
          sequence: op.sequence,
          isOvertimeSlot: false,
          batchSize: op.batchSize || 1,
          slackTime: 0
        });
      }

      const jobSchedule: JobSchedule = {
        jobId: job.jobId,
        plannedStartDate: operationSchedules[0].plannedStartDate,
        plannedEndDate: operationSchedules[operationSchedules.length - 1].plannedEndDate,
        operationSchedules,
        estimatedTardiness: 0,
        status: 'Scheduled'
      };

      // Non-blocking dependency check on the final placement: catches the
      // cases the drop-time clamp can't (back-scheduled leading ops of a
      // master, or a sub-job now ending after its master starts).
      const depWarning = describeDependencyViolation(
        job.jobId,
        jobSchedule.plannedStartDate.getTime(),
        jobSchedule.plannedEndDate.getTime(),
        masterParentMap,
        baseSchedule
      );
      if (depWarning) {
        toast(`⚠ ${depWarning}`, { icon: '⚠️', duration: 7000 });
      }

      const mergedJobs = [
        ...baseSchedule.jobSchedules.filter((j) => j.jobId !== job.jobId),
        jobSchedule
      ].sort((a, b) => a.plannedStartDate.getTime() - b.plannedStartDate.getTime());

      const updatedSchedule: Schedule = {
        ...baseSchedule,
        jobSchedules: mergedJobs,
        metrics: {
          ...baseSchedule.metrics,
          totalJobsScheduled: mergedJobs.length
        }
      };

      setSchedule(updatedSchedule);
      markScheduleEdited();
      undoRedoManager.addState(updatedSchedule, `Dropped ${job.jobId} on ${droppedOnWorkcentre}`);
      const firstOp = operationSchedules[0];
      const anchorOp = operationSchedules[anchorIdx] ?? firstOp;

      // Keep the board focused: highlight the just-scheduled job, focus the
      // correct workcentre lane on the Gantt, and switch to the Gantt tab.
      setHighlightJobId(job.jobId);
      if (anchorOp?.workcentreId) {
        // Drive MachineGanttBoard's internal lane filter via the focusWorkcentre prop.
        setGanttFocusWorkcentre(anchorOp.workcentreId);
        // Also keep the job-list workcentre filter in sync.
        setSelectedWorkcentre((prev) =>
          prev.includes(anchorOp.workcentreId) ? prev : [anchorOp.workcentreId]
        );
      }
      setContentTab('gantt');

      toast.success(`${job.jobId} scheduled — ${anchorOp.workcentreId} starts ${new Date(anchorOp.plannedStartDate).toLocaleString()}`);
    } catch (error: any) {
      console.error('Autoschedule error:', error);
      toast.error(error.message || 'Failed to autoschedule job');
    }
  };

  /**
   * Click a job row in the Production Jobs grid:
   * - If scheduled → highlight it and switch the lower panel to the Gantt tab so it scrolls into view.
   * - If not scheduled → just toggle the row highlight.
   * - Second click on already-highlighted job → deselect.
   */
  const handleJobRowClick = (jobId: string) => {
    if (highlightJobId === jobId) {
      // Second click on the same job: clear the focus AND the lane filter.
      setHighlightJobId(null);
      setGanttFocusWorkcentre(null);
      setSelectedWorkcentre([]);
      return;
    }
    setHighlightJobId(jobId);

    const jobSchedule = schedule?.jobSchedules.find((j) => j.jobId === jobId);
    const job = openJobs.find((j) => j.jobId === jobId);

    // Every workcentre the job uses (scheduled ops) or might use (routing),
    // in execution order — the Gantt shows ALL of these lanes.
    const scheduledWcs = jobSchedule
      ? [...jobSchedule.operationSchedules]
          .sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime())
          .map((op) => op.workcentreId)
      : [];
    const routingWcs = job
      ? [...(job.operations || [])].sort((a, b) => a.sequence - b.sequence).map((op) => op.workcentreId)
      : [];
    const wcs = Array.from(new Set((scheduledWcs.length ? scheduledWcs : routingWcs).filter(Boolean)));

    if (wcs.length) {
      // Override the app-level workcentre filter: ContentTabPanel only hands
      // the Gantt resources for `selectedWorkcentre`, so a previously applied
      // filter would hide the other lanes this job needs. A job click must
      // ALWAYS bring every workcentre/machine the job uses into view.
      setSelectedWorkcentre(wcs);
    }
    setGanttFocusWorkcentre(wcs.length ? wcs : null);
    setContentTab('gantt');

    if (!jobSchedule && wcs.length) {
      toast(`${jobId} is not scheduled yet — showing the ${wcs.length} machine lane${wcs.length === 1 ? '' : 's'} it may use`, { icon: 'ℹ️' });
    }
  };

  const openJobContextMenu = (e: React.MouseEvent, jobId: string) => {
    e.preventDefault();
    setJobContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      jobId
    });
  };

  const closeJobContextMenu = () => {
    setJobContextMenu((prev) => ({ ...prev, visible: false, jobId: null }));
  };

  const unscheduleJob = (jobId: string) => {
    if (!schedule) return;
    const updatedSchedule = {
      ...schedule,
      jobSchedules: schedule.jobSchedules.filter((j) => j.jobId !== jobId),
      metrics: {
        ...schedule.metrics,
        totalJobsScheduled: Math.max(0, schedule.jobSchedules.length - 1)
      }
    };
    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Unscheduled ${jobId}`);
    toast.success(`Job ${jobId} unscheduled`);
  };

  /**
   * Schedule a single operation from the Production Jobs grid.
   * Finds the next available slot on the operation's workcentre and places it
   * in the schedule without touching any other operations.
   */
  const autoScheduleSingleOperation = async (job: Job, opId: string) => {
    const op = job.operations.find((o) => String(o.opId) === String(opId));
    if (!op) { toast.error(`Operation ${opId} not found`); return; }

    const wc: string = (op as any).workcentreId || (op as any).workCentre || '';
    if (!wc) { toast.error(`Operation ${opId} has no workcentre assigned`); return; }

    const baseSchedule = schedule ? convertScheduleDates(schedule) : {
      jobSchedules: [] as JobSchedule[],
      resourceLoads: [],
      constraintViolations: [],
      metrics: { totalJobsScheduled: 0, totalOpsScheduled: 0, averageLateness: 0, onTimeRate: 0, utilizationRate: 0, criticalPathLength: 0 }
    };

    const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
    const searchFromMs = Math.max(Date.now(), horizonBounds.startMs);
    if (searchFromMs > horizonBounds.endMs) {
      horizonBounds.endMs = searchFromMs + 90 * 24 * 60 * 60 * 1000;
    }

    // Build intervals for this workcentre, skipping this op if already scheduled.
    type Interval = { start: number; end: number };
    const intervals: Interval[] = [];
    for (const js of baseSchedule.jobSchedules) {
      for (const existingOp of js.operationSchedules) {
        if (js.jobId === job.jobId && String(existingOp.opId) === String(opId)) continue;
        if (String(existingOp.workcentreId) !== wc) continue;
        intervals.push({
          start: new Date(existingOp.plannedStartDate).getTime(),
          end: new Date(existingOp.plannedEndDate).getTime()
        });
      }
    }

    // One operation at a time per production line (workcentre capacity = 1),
    // matching the auto-scheduler. Manual drops snap to the next free slot
    // rather than overlapping another operation on the same line.
    const capacity = 1;

    const setupMinutes = Math.max(0, Number((op as any).setupTime || 0));
    const runMinutes   = Math.max(1, Number((op as any).runTime || (op as any).duration || 1));
    const queueMinutes = Math.max(0, Number((op as any).queueTime || 0));
    const moveMinutes  = Math.max(0, Number((op as any).moveTime || 0));
    const bookedMinutes = setupMinutes + runMinutes;
    const durationMs   = bookedMinutes * 60_000;

    // Capacity-aware slot check.
    const canFitHere = (startMs: number, endMs: number): boolean => {
      let concurrent = 0;
      for (const iv of intervals) {
        if (iv.start < endMs && iv.end > startMs) concurrent++;
        if (concurrent >= capacity) return false;
      }
      return true;
    };

    // Gather candidates: desired start + all interval ends after desired start.
    const candidateSet = new Set<number>([searchFromMs]);
    for (const iv of intervals) {
      if (iv.end >= searchFromMs) candidateSet.add(iv.end);
    }
    const candidates = Array.from(candidateSet).sort((a, b) => a - b);

    let startMs: number = searchFromMs;
    let placed = false;
    for (const c of candidates) {
      if (canFitHere(c, c + durationMs)) { startMs = c; placed = true; break; }
    }
    if (!placed) {
      // Fall back to after the last booked slot.
      const lastEnd = intervals.length > 0 ? Math.max(...intervals.map((iv) => iv.end)) : searchFromMs;
      startMs = Math.max(searchFromMs, lastEnd);
    }

    const endMs       = startMs + durationMs;
    const setupEndMs  = startMs + setupMinutes * 60_000;

    // Pick assigned machine.
    const altMachines = alternativeGroups
      .filter((g) => g.workcentreId === wc)
      .flatMap((g) => g.machineIds || []);
    const candidateMachines = Array.from(new Set([...((op as any).qualifiedResourceIds || []), ...altMachines].filter(Boolean)));
    const assignedMachine = candidateMachines[0] || wc;

    const opSchedule: OperationSchedule = {
      opId:             String(op.opId),
      workcentreId:     wc,
      resourceId:       assignedMachine,
      plannedStartDate: new Date(startMs),
      plannedEndDate:   new Date(endMs),
      duration:         bookedMinutes,
      setupTime:        setupMinutes,
      runTime:          runMinutes,
      queueTime:        queueMinutes,
      moveTime:         moveMinutes,
      setupStart:       new Date(startMs),
      setupEnd:         new Date(setupEndMs),
      runStart:         new Date(setupEndMs),
      runEnd:           new Date(endMs),
      queueEnd:         new Date(startMs),
      moveEnd:          new Date(endMs + moveMinutes * 60_000),
      sequence:         (op as any).sequence ?? 0,
      isOvertimeSlot:   false,
      batchSize:        (op as any).batchSize || 1,
      slackTime:        0
    };

    // Upsert: merge with any existing JobSchedule for this job.
    const existingJS = baseSchedule.jobSchedules.find((j) => j.jobId === job.jobId);
    let newJobSched: JobSchedule;
    if (existingJS) {
      const updatedOps = [
        ...existingJS.operationSchedules.filter((o) => String(o.opId) !== String(opId)),
        opSchedule
      ].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const starts = updatedOps.map((o) => new Date(o.plannedStartDate).getTime());
      const ends   = updatedOps.map((o) => new Date(o.plannedEndDate).getTime());
      newJobSched = {
        ...existingJS,
        operationSchedules: updatedOps,
        plannedStartDate: new Date(Math.min(...starts)),
        plannedEndDate:   new Date(Math.max(...ends))
      };
    } else {
      newJobSched = {
        jobId: job.jobId,
        plannedStartDate: opSchedule.plannedStartDate,
        plannedEndDate:   opSchedule.plannedEndDate,
        operationSchedules: [opSchedule],
        estimatedTardiness: 0,
        status: 'Scheduled'
      };
    }

    const mergedJobs = [
      ...baseSchedule.jobSchedules.filter((j) => j.jobId !== job.jobId),
      newJobSched
    ].sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime());

    const updatedSchedule: Schedule = {
      ...(baseSchedule as Schedule),
      jobSchedules: mergedJobs,
      metrics: { ...(baseSchedule as Schedule).metrics, totalJobsScheduled: mergedJobs.length }
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Scheduled op ${opId} of ${job.jobId}`);
    toast.success(`Op ${opId} → ${wc} at ${new Date(startMs).toLocaleString()}`);
  };

  // Keep the ref in sync so renderOperationsTable (defined above) can call this.
  scheduleOpRef.current = autoScheduleSingleOperation;

  const scheduleAroundJob = async (jobId: string, mode: 'left' | 'right' | 'both' | 'master') => {
    const selectedJob = openJobs.find((j) => j.jobId === jobId) || visibleJobSource.find((j) => j.jobId === jobId);
    if (!selectedJob) {
      toast.error('Select a valid job first');
      return;
    }

    const { startMs, endMs } = getSchedulingHorizonBounds();
    const spanMs = Math.max(24 * 60 * 60 * 1000, endMs - startMs);
    const dueMsRaw = new Date(selectedJob.dueDate).getTime();
    const dueMs = Number.isFinite(dueMsRaw)
      ? Math.min(endMs - 60 * 1000, Math.max(startMs, dueMsRaw))
      : startMs + Math.floor(spanMs / 2);

    const getAnchorDate = (anchorMode: 'left' | 'right' | 'both', offsetIndex = 0) => {
      let anchorMs = dueMs;
      if (anchorMode === 'left') anchorMs = Math.max(startMs, dueMs - Math.floor(spanMs * 0.35));
      if (anchorMode === 'right') anchorMs = Math.min(endMs - 60 * 1000, dueMs + Math.floor(spanMs * 0.05));
      if (anchorMode === 'both') anchorMs = Math.max(startMs, dueMs - Math.floor(spanMs * 0.18));
      anchorMs = Math.min(endMs - 60 * 1000, anchorMs + offsetIndex * 60 * 60 * 1000);
      return new Date(anchorMs);
    };

    if (mode === 'master') {
      const masterRootId = getMasterRootJobId(selectedJob);
      const familyJobs = visibleJobSource
        .filter((job) => getMasterRootJobId(job) === masterRootId || job.jobId === masterRootId)
        .sort((a, b) => {
          const aRank = a.jobId === masterRootId ? 0 : 1;
          const bRank = b.jobId === masterRootId ? 0 : 1;
          const aDue = new Date(a.dueDate).getTime() || 0;
          const bDue = new Date(b.dueDate).getTime() || 0;
          return (aRank - bRank) || (a.priority - b.priority) || (aDue - bDue) || a.jobId.localeCompare(b.jobId);
        });

      if (!familyJobs.length) {
        toast.error('No master job family found');
        return;
      }

      // Master/sub precedence (mirrors the engine rule): place every sub-job
      // first, then anchor the master after the latest sub-job end so it can
      // never start before the jobs that feed it are complete.
      const subJobs = familyJobs.filter((j) => j.jobId !== masterRootId);
      const masterJob = familyJobs.find((j) => j.jobId === masterRootId);

      for (const [index, familyJob] of subJobs.entries()) {
        const primaryWorkcentre = familyJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
        await autoScheduleDroppedJob(familyJob.jobId, getAnchorDate('both', index), primaryWorkcentre);
      }

      if (masterJob) {
        // Read fresh store state — autoScheduleDroppedJob has already merged
        // the sub-job placements into the schedule by the time it resolves.
        const current = useScheduleStore.getState().schedule;
        let latestSubEndMs = 0;
        for (const sub of subJobs) {
          const js = current?.jobSchedules.find((j) => j.jobId === sub.jobId);
          if (js) latestSubEndMs = Math.max(latestSubEndMs, new Date(js.plannedEndDate).getTime());
        }
        const masterAnchor = latestSubEndMs > 0
          ? new Date(latestSubEndMs + 60 * 1000)
          : getAnchorDate('both', subJobs.length);
        const primaryWorkcentre = masterJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
        await autoScheduleDroppedJob(masterJob.jobId, masterAnchor, primaryWorkcentre);
      }

      toast.success(`Scheduled master job group ${masterRootId} — sub-jobs first, master after`);
      return;
    }

    const primaryWorkcentre = selectedJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
    await autoScheduleDroppedJob(jobId, getAnchorDate(mode), primaryWorkcentre);
  };

  // Wired to a button planned for the ribbon; not bound yet but kept ready.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleScheduleAround = async () => {
    const targetJobId = highlightJobId || jobContextMenu.jobId;
    if (!targetJobId) {
      toast.error('Select or right-click a job first');
      return;
    }
    await scheduleAroundJob(targetJobId, scheduleAroundMode);
  };

  const executeJobContextCommand = async (command: string) => {
    const jobId = jobContextMenu.jobId;
    if (!jobId) return;

    const selectedJob = openJobs.find((j) => j.jobId === jobId);

    switch (command) {
      case 'autoschedule':
        openScheduleSetup([jobId]);
        break;
      case 'schedule-around':
        await scheduleAroundJob(jobId, scheduleAroundMode);
        break;
      case 'schedule-around-left':
        await scheduleAroundJob(jobId, 'left');
        break;
      case 'schedule-around-right':
        await scheduleAroundJob(jobId, 'right');
        break;
      case 'schedule-around-both':
        await scheduleAroundJob(jobId, 'both');
        break;
      case 'schedule-around-master':
        await scheduleAroundJob(jobId, 'master');
        break;
      case 'unschedule-selected':
        unscheduleJob(jobId);
        break;
      case 'edit-job':
        setManageTab('none');
        toggleJobExpanded(jobId);
        toast.success(`Editing ${jobId}`);
        break;
      case 'load-required-machines':
        if (selectedJob?.operations?.length) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
          toast.success(`Loaded machines for ${jobId}`);
        } else {
          toast.error('No operation machines found for this job');
        }
        break;
      case 'unload-all-machines':
        setSelectedWorkcentre([]);
        toast.success('Machine filter reset');
        break;
      case 'highlight-object':
        if (selectedJob?.operations?.[0]) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
        }
        setExpandedJobs((prev) => ({ ...prev, [jobId]: true }));
        toast.success(`Highlighted ${jobId}`);
        break;
      case 'show-details':
        setExpandedJobs((prev) => ({ ...prev, [jobId]: true }));
        toast.success(`Showing details for ${jobId}`);
        break;
      case 'job-status':
        toast.success(`Job ${jobId} status: ${selectedJob?.status || 'Unknown'}`);
        break;
      case 'undo':
        handleUndo();
        break;
      case 'redo':
        handleRedo();
        break;
      case 'refresh':
        await loadJobsAndResources();
        toast.success('Jobs refreshed');
        break;
      case 'save-and-publish':
        await exportToSyspro();
        break;
      case 'load-machines':
        if (selectedJob?.operations?.[0]) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
          toast.success(`Loaded machine lane ${selectedJob.operations[0].workcentreId}`);
        }
        break;
      case 'material-planning':
        setContentTab('materials');
        setHighlightJobId(jobId);
        toast.success(`Showing materials for job ${jobId}`);
        break;
      case 'possible-errors': {
        const violations = schedule?.constraintViolations?.filter(v => v.affectedJobId === jobId) || [];
        if (violations.length > 0) {
          toast.error(`Job ${jobId}: ${violations.length} constraint violation(s) — check Constraints tab`);
          setContentTab('constraints');
        } else {
          toast.success(`No constraint violations found for job ${jobId}`);
        }
        break;
      }
      case 'pin':
        void toggleJobFlag(jobId, 'pinned');
        break;
      case 'exclude':
        void toggleJobFlag(jobId, 'excluded');
        break;
      case 'deadline':
        setHighlightJobId(jobId);
        toast(`Job ${jobId} — due date: ${openJobs.find(j => j.jobId === jobId)?.dueDate || 'unknown'}`, { icon: '📅' });
        break;
      case 'actions':
        toast(`Actions for ${jobId}: Schedule Around, Pin, Exclude, View Materials`, { icon: '⚡', duration: 4000 });
        break;
      default:
        break;
    }

    closeJobContextMenu();
  };

  const handleDraggableMove = (opId: string, newStartDate: Date, newEndDate: Date) => {
    if (!schedule) return;

    const horizonBounds = getSchedulingHorizonBounds();
    if (newStartDate.getTime() < horizonBounds.startMs || newEndDate.getTime() > horizonBounds.endMs) {
      toast.error('Operation must stay within the selected Start and End dates');
      return;
    }

    const updatedJobSchedules = schedule.jobSchedules.map((job) => {
      const updatedOps = job.operationSchedules.map((op) =>
        op.opId === opId
          ? {
              ...op,
              plannedStartDate: newStartDate,
              plannedEndDate: newEndDate
            }
          : op
      );

      const hasUpdated = updatedOps.some((op) => op.opId === opId);
      if (!hasUpdated) return job;

      const opStarts = updatedOps.map((op) => new Date(op.plannedStartDate).getTime());
      const opEnds = updatedOps.map((op) => new Date(op.plannedEndDate).getTime());

      return {
        ...job,
        operationSchedules: updatedOps,
        plannedStartDate: new Date(Math.min(...opStarts)),
        plannedEndDate: new Date(Math.max(...opEnds))
      };
    });

    const updatedSchedule: Schedule = {
      ...schedule,
      jobSchedules: updatedJobSchedules
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Dragged operation ${opId}`);
    toast.success(`Operation ${opId} moved`);
  };

  const handleScheduleBoardOperationMove = async (
    jobId: string,
    opId: string,
    proposedStartDate: Date,
    droppedOnWorkcentre: string,
    droppedOnMachineId?: string
  ) => {
    if (!schedule) return;

    const working = convertScheduleDates(schedule);
    const targetJob = working.jobSchedules.find((j) => j.jobId === jobId);
    if (!targetJob) {
      toast.error(`Job ${jobId} not found in schedule`);
      return;
    }

    const sourceJob = openJobs.find((j) => j.jobId === jobId);
    const sequenceByOpId = new Map<string, number>();
    if (sourceJob?.operations?.length) {
      sourceJob.operations.forEach((op) => sequenceByOpId.set(String(op.opId), op.sequence));
    }

    const sortedOps = [...targetJob.operationSchedules].sort((a, b) => {
      const aSeq = sequenceByOpId.get(String(a.opId)) ?? Number(String(a.opId).replace(/\D/g, '')) ?? 999999;
      const bSeq = sequenceByOpId.get(String(b.opId)) ?? Number(String(b.opId).replace(/\D/g, '')) ?? 999999;
      return aSeq - bSeq;
    });

    const movedIdx = sortedOps.findIndex((op) => String(op.opId) === String(opId));
    if (movedIdx < 0) {
      toast.error(`Operation ${opId} not found`);
      return;
    }

    const movedOriginal = sortedOps[movedIdx];
    const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
    const predecessorEndMs = movedIdx > 0
      ? new Date(sortedOps[movedIdx - 1].plannedEndDate).getTime()
      : Number.NEGATIVE_INFINITY;
    let precedenceCursorMs = Math.max(new Date(proposedStartDate).getTime(), predecessorEndMs, horizonBounds.startMs);

    // Extend the working horizon when the user drops past the planning-horizon end.
    if (precedenceCursorMs > horizonBounds.endMs) {
      horizonBounds.endMs = precedenceCursorMs + 90 * 24 * 60 * 60 * 1000;
      (horizonBounds as any).endDate = new Date(horizonBounds.endMs);
    }

    const definitionsResponse = await resourceService.getDefinitions().catch(() => ({ definitions: [] as any[] }));
    const quantityByWorkcentre: Record<string, number> = {};
    for (const definition of definitionsResponse.definitions || []) {
      const wc = String(definition.workcentreId || '');
      if (!wc || definition.activated === false) continue;
      const qty = Math.max(1, Number(definition.quantity || 1));
      quantityByWorkcentre[wc] = (quantityByWorkcentre[wc] || 0) + qty;
    }

    type Interval = { start: number; end: number };
    const intervalsByWorkcentre = new Map<string, Interval[]>();

    for (const js of working.jobSchedules) {
      for (const existing of js.operationSchedules) {
        const isSameJobTail = js.jobId === jobId &&
          sortedOps.slice(movedIdx).some((tail) => String(tail.opId) === String(existing.opId));
        if (isSameJobTail) continue;

        const wc = String(existing.workcentreId || '');
        if (!intervalsByWorkcentre.has(wc)) intervalsByWorkcentre.set(wc, []);
        intervalsByWorkcentre.get(wc)!.push({
          start: new Date(existing.plannedStartDate).getTime(),
          end: new Date(existing.plannedEndDate).getTime()
        });
      }
    }

    // Slot maths extracted to utils/slotFinder.ts (unit-tested); calendar
    // awareness injected via the App's shift-window helpers.
    const findEarliestSlot = (
      desiredStartMs: number,
      durationMs: number,
      intervals: Interval[],
      capacity: number,
      workcentreId: string
    ): number | null =>
      findEarliestSlotOrForce({
        desiredStartMs,
        durationMs,
        intervals,
        capacity,
        workcentreId,
        horizonStartMs: horizonBounds.startMs,
        adapters: { align: alignToProductiveWindow, productiveEnd: calculateProductiveEndMs },
        onForcedPlacement: (wc) =>
          toast(`⚠ ${wc}: no free calendar slot found — operation placed outside normal shift hours`, { icon: '⚠️' }),
      });

    const recalculatedTail = sortedOps.map((op, idx) => ({ ...op }));

    for (let i = movedIdx; i < recalculatedTail.length; i++) {
      const op = recalculatedTail[i] as any;
      const setupMinutes = Math.max(Number(op.setupTime || 0), 0);
      const runMinutes = Math.max(Number(op.runTime || op.duration || 1), 1);
      const queueMinutes = Math.max(Number(op.queueTime || 0), 0);
      const moveMinutes = Math.max(Number(op.moveTime || 0), 0);
      const bookedMinutes = setupMinutes + runMinutes;
      const durationMs = Math.max(1, bookedMinutes) * 60 * 1000;
      const wc = i === movedIdx ? droppedOnWorkcentre || op.workcentreId : op.workcentreId;
      const capacity = 1; // one operation at a time per production line
      const intervals = intervalsByWorkcentre.get(wc) || [];
      const desiredStartMs = precedenceCursorMs + queueMinutes * 60000;
      const startMs = findEarliestSlot(desiredStartMs, durationMs, intervals, capacity, wc);
      if (startMs === null) {
        toast.error(`Operation ${op.opId} cannot fit within the selected Start and End dates`);
        return;
      }
      const endMs = calculateProductiveEndMs(startMs, durationMs, wc);

      const setupStart = new Date(startMs);
      const setupEndMs = calculateProductiveEndMs(startMs, setupMinutes * 60000, wc);
      const setupEnd = new Date(setupEndMs);
      const runStart = new Date(setupEndMs);
      const runEndMs = calculateProductiveEndMs(setupEndMs, runMinutes * 60000, wc);
      const runEnd = new Date(runEndMs);
      const moveEnd = new Date(runEndMs + moveMinutes * 60000);

      op.workcentreId = wc;
      // Machine assignment (S3.3): when the op was dropped on a specific
      // machine lane of the SAME workcentre, reassign it to that machine.
      // Machines of other workcentres are rejected — the board already
      // blocks cross-workcentre op drops, this is defence in depth.
      if (i === movedIdx && droppedOnMachineId && droppedOnMachineId !== op.resourceId) {
        const targetMachine = resources.find((r) => r.resourceId === droppedOnMachineId);
        if (targetMachine && targetMachine.worcentreId === wc) {
          op.resourceId = droppedOnMachineId;
        }
      }
      // Never leave resourceId empty — lane rendering keys by machine id.
      op.resourceId = op.resourceId || wc;
      op.duration = bookedMinutes;
      op.plannedStartDate = new Date(startMs);
      op.plannedEndDate = new Date(endMs);
      op.setupStart = setupStart;
      op.setupEnd = setupEnd;
      op.runStart = runStart;
      op.runEnd = runEnd;
      op.queueEnd = new Date(setupStart.getTime());
      op.moveEnd = moveEnd;

      intervals.push({ start: startMs, end: endMs });
      intervalsByWorkcentre.set(wc, intervals);
      precedenceCursorMs = moveEnd.getTime();
    }

    const updatedJobSchedules = working.jobSchedules.map((js) => {
      if (js.jobId !== jobId) return js;

      const byOpId = new Map<string, typeof recalculatedTail[number]>(
        recalculatedTail.map((op) => [String(op.opId), op])
      );
      const mergedOps = js.operationSchedules.map((op) => byOpId.get(String(op.opId)) || op);
      const starts = mergedOps.map((op) => new Date(op.plannedStartDate).getTime());
      const ends = mergedOps.map((op) => new Date(op.plannedEndDate).getTime());

      return {
        ...js,
        operationSchedules: mergedOps,
        plannedStartDate: new Date(Math.min(...starts)),
        plannedEndDate: new Date(Math.max(...ends))
      };
    });

    const updatedSchedule: Schedule = {
      ...working,
      jobSchedules: updatedJobSchedules
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Moved ${jobId}/${opId} on board`);

    // Non-blocking master/sub dependency check on the moved job's new window.
    const movedJobSchedule = updatedJobSchedules.find((j) => j.jobId === jobId);
    if (movedJobSchedule) {
      const depWarning = describeDependencyViolation(
        jobId,
        new Date(movedJobSchedule.plannedStartDate).getTime(),
        new Date(movedJobSchedule.plannedEndDate).getTime(),
        masterParentMap,
        updatedSchedule
      );
      if (depWarning) {
        toast(`⚠ ${depWarning}`, { icon: '⚠️', duration: 7000 });
      }
    }

    const movedResult = updatedJobSchedules
      .find((j) => j.jobId === jobId)
      ?.operationSchedules.find((x) => String(x.opId) === String(opId));
    const from = format(new Date(movedOriginal.plannedStartDate), 'HH:mm:ss');
    const to = movedResult ? format(new Date(movedResult.plannedStartDate), 'HH:mm:ss') : format(new Date(proposedStartDate), 'HH:mm:ss');
    toast.success(`Operation sequence updated (${from} -> ${to})`);
  };
  // Sync ref so keyboard nudge shortcut can call the latest version of this function
  operationMoveRef.current = handleScheduleBoardOperationMove;

  // Wired to the file inputs in the Import tab.

  return {
    alignToProductiveWindow,
    calculateProductiveEndMs,
    autoScheduleDroppedJob,
    handleJobRowClick,
    openJobContextMenu,
    closeJobContextMenu,
    executeJobContextCommand,
    handleDraggableMove,
    handleScheduleBoardOperationMove,
  };
}
