import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { addDays, format, differenceInMinutes, startOfDay, endOfDay, startOfWeek } from 'date-fns';
import { Resource, Schedule, Job, ConstraintViolation } from '../types';
import { GanttSettingsState, GANTT_SETTINGS_DEFAULTS } from './GanttSettings';
import GanttTooltip from './GanttTooltip';
import GanttContextMenu, { ContextMenuState } from './GanttContextMenu';
import DragPreview, { DragPreviewState } from './DragPreview';
import GanttLegend from './GanttLegend';
import GanttOperationBar from './GanttOperationBar';
import { buildParentMap, getMasterRootJobId } from '../utils/masterSub';
import toast from 'react-hot-toast';
import { pinService, apiErrorMessage, type PinnedOperationDto } from '../services/api';
import { useScheduleStore } from '../stores/scheduleStore';
import './MachineGanttBoard.css';

/** Reload locks from the server into the store (after a bulk lock/unlock). */
const refreshPins = async () => {
  const pins = await pinService.getAll();
  const details = new Map<string, PinnedOperationDto>();
  for (const p of pins) details.set(`${p.jobId}::${p.opId}`, p);
  const st = useScheduleStore.getState();
  st.setPinnedOpDetails(details);
  st.setPinnedOps(new Set(details.keys()));
};

const timeFenceLock = async () => {
  if (useScheduleStore.getState().activeVersion) {
    toast.error('Locks apply to the master plan — go back to the master (Versions tab) first.');
    return;
  }
  const answer = window.prompt('Time-fence lock: lock every operation that starts within the next N days (at its current machine and time).', '2');
  if (answer === null) return;
  const days = Number(answer);
  if (!Number.isFinite(days) || days <= 0) { toast.error('Enter a number of days'); return; }
  try {
    const until = new Date(Date.now() + days * 86_400_000);
    const r = await pinService.timeFence(until);
    await refreshPins();
    toast.success(`🔒 ${r.added} operations locked up to ${until.toLocaleString()} (${r.total} locked in total)`);
  } catch (err) { toast.error(apiErrorMessage(err, 'Could not apply the time fence')); }
};

const clearLocks = async () => {
  if (!window.confirm('Remove ALL locks? Every operation becomes free to move on the next generate.')) return;
  try {
    const r = await pinService.removeAll();
    await refreshPins();
    toast.success(`🔓 ${r.removed} locks removed`);
  } catch (err) { toast.error(apiErrorMessage(err, 'Could not remove locks')); }
};

type ColorMode = 'workcentre' | 'lateness' | 'status' | 'critical';

// Readable, well-separated hues used to colour bars by workcentre / production
// line. Cycled by lane index so each line is visually distinct.
const WORKCENTRE_PALETTE = [
  '#4f8bff', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];
// Master/sub dependency visuals: parentMap/depRoleByJobId feed the M/S badges,
// dependencyLinks draws sub→master arrows for the highlighted family.

interface LockedOps {
  [key: string]: boolean; // "jobId::opId" -> locked
}

/** Local tooltip state — kept inline since only MachineGanttBoard manages it */
interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: React.ReactNode;
}

interface MachineGanttBoardProps {
  schedule: Schedule | null;
  resources: Resource[];
  horizonStart: string;
  horizonEnd: string;
  loading?: boolean;
  highlightJobId?: string | null;
  jobs?: Job[];
  ganttPrefs?: GanttSettingsState;
  /** Optional list of constraint violations — bars for affected operations will pulse red */
  constraintViolations?: ConstraintViolation[];
  /** If set, the bar for this opId gets a focused pulse and is scrolled into view */
  focusedViolationOpId?: string;
  onJobDrop: (jobId: string, dropDate: Date, workcentreId: string, machineId?: string) => void;
  onOperationMove?: (jobId: string, opId: string, newStartDate: Date, workcentreId: string, machineId?: string) => void;
  onHighlightJob?: (jobId: string | null) => void;
  /** Open the material-availability modal for this job. */
  onShowMaterials?: (jobId: string) => void;
  /** Externally-managed locked ops ("jobId::opId" keys) */
  externalLockedOps?: Set<string>;
  /** Called when user locks/unlocks an op from the Gantt bar */
  onLockChange?: (key: string, locked: boolean) => void;
  /**
   * When set, the board scrolls to and highlights this workcentre lane.
   * Changing the value (e.g. after a Schedule Around action) overrides
   * the internal lane-filter state so the user immediately sees the result.
   * Pass null to clear the focus without filtering.
   */
  focusWorkcentre?: string | string[] | null;
}

// ContextMenuState is re-exported from GanttContextMenu; re-import here for local use.
// DragPreviewState is re-exported from DragPreview.

const WORKCENTRE_COLORS = [
  '#3e7fe7', '#e45c3c', '#2db87a', '#d4a017', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4', '#8bc34a',
  '#ff5722', '#607d8b', '#795548', '#ff9800', '#009688',
];

const getLateness = (endDate: Date, jobDueDate?: Date): number => {
  if (!jobDueDate) return 0;
  return differenceInMinutes(endDate, jobDueDate);
};

const getLatenessColor = (lateness: number): string => {
  if (lateness > 0) return '#ef4444'; // late
  if (lateness > -60 * 8) return '#f59e0b'; // at risk (within 8h)
  return '#10b981'; // on time
};

/** Pure utility — defined at module level so it can be used before the component body. */
const timeToMinutes = (value?: string): number => {
  const [hours, minutes] = String(value || '00:00').split(':').map((part) => Number(part) || 0);
  return Math.max(0, Math.min(1440, hours * 60 + minutes));
};

const MachineGanttBoard: React.FC<MachineGanttBoardProps> = ({
  schedule,
  resources,
  horizonStart,
  horizonEnd,
  loading = false,
  highlightJobId,
  jobs = [],
  ganttPrefs,
  onJobDrop,
  onOperationMove,
  onHighlightJob,
  onShowMaterials,
  constraintViolations = [],
  focusedViolationOpId,
  externalLockedOps,
  onLockChange,
  focusWorkcentre,
}) => {
  const prefs: GanttSettingsState = { ...GANTT_SETTINGS_DEFAULTS, ...ganttPrefs };

  // Derive a Set of affected opIds from constraint violations for fast bar lookup
  const violatedOpIds = useMemo(
    () => new Set(constraintViolations.filter(v => v.affectedOperationId).map(v => v.affectedOperationId!)),
    [constraintViolations]
  );

  // S3.1: When a violation is focused from the Constraints tab, scroll its bar into view.
  useEffect(() => {
    if (!focusedViolationOpId) return;
    // Small delay so the Gantt tab has time to mount before we query the DOM.
    const timer = setTimeout(() => {
      const el = ganttRef.current?.querySelector<HTMLElement>(`[data-op-id="${CSS.escape(focusedViolationOpId)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, [focusedViolationOpId]);

  const [zoom, setZoom] = useState<'week' | 'day' | 'hour' | 'minute'>(prefs.defaultZoom);
  const [colorMode, setColorMode] = useState<ColorMode>(prefs.colorMode);
  const [lockedOps, setLockedOps] = useState<LockedOps>({});
  const [selectedWorkcentre, setSelectedWorkcentre] = useState<string | null>(null);

  // When the parent tells us to focus a specific workcentre (e.g. after
  // scheduling), highlight that lane and scroll its header into view. All lanes
  // stay visible — focus never filters the board.
  useEffect(() => {
    if (focusWorkcentre === undefined) return;
    const list = Array.isArray(focusWorkcentre)
      ? focusWorkcentre
      : focusWorkcentre
      ? [focusWorkcentre]
      : null;
    setSelectedWorkcentre(list && list.length === 1 ? list[0] : null);
    if (list && list.length) {
      // Small delay so the re-render completes first.
      setTimeout(() => {
        const el = ganttRef.current?.querySelector<HTMLElement>(`[data-wc-id="${CSS.escape(list[0])}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 80);
    }
  }, [focusWorkcentre]);

  // When a job is highlighted (clicked in the job pane), scroll its earliest
  // scheduled operation bar into view so the job is visibly "brought" onto
  // the board.
  useEffect(() => {
    if (!highlightJobId || !schedule) return;
    const js = schedule.jobSchedules.find((j) => j.jobId === highlightJobId);
    if (!js?.operationSchedules?.length) return;
    const first = [...js.operationSchedules].sort(
      (a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime()
    )[0];
    const timer = setTimeout(() => {
      const el = ganttRef.current?.querySelector<HTMLElement>(`[data-op-id="${CSS.escape(String(first.opId))}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }, 160);
    return () => clearTimeout(timer);
  }, [highlightJobId, schedule]);
  const [showLegend, setShowLegend] = useState(prefs.showLegend);
  const [showUtilBars, setShowUtilBars] = useState(prefs.showUtilBars);
  const [showShift, setShowShift] = useState(prefs.showShift);
  const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, content: null });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState>({
    visible: false, x: 0, y: 0, date: null, endDate: null,
    jobId: '', jobType: '', opSeq: '', opDesc: '', stockCode: '', stockDesc: '', canDrop: true
  });
  /** Multi-select: set of "jobId::opId" keys currently selected */
  const [selectedOps, setSelectedOps] = useState<Set<string>>(new Set());
  const draggedItemRef = useRef<{ type: 'operation' | 'job'; jobId: string; opId?: string } | null>(null);
  /** Anchor op for multi-select drag delta calculation */
  const dragAnchorRef = useRef<{ opKey: string; origStartMs: number; grabOffsetMs: number } | null>(null);

  /** Ghost-bar overlay: one entry per scheduled operation of the dragged job */
  interface GhostBar {
    key: string;
    laneId: string; // resourceId (machine lane)
    left: number;   // px from timeline start
    width: number;  // px
    label: string;
  }
  const [ghostBars, setGhostBars] = useState<GhostBar[]>([]);
  const ganttRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const minDate = useMemo(
    () => new Date(horizonStart + 'T00:00:00'),
    [horizonStart]
  );
  const maxDate = useMemo(
    () => new Date(horizonEnd + 'T00:00:00'),
    [horizonEnd]
  );

  const timelineStart = useMemo(() => startOfDay(minDate), [minDate]);
  const timelineEnd = useMemo(() => endOfDay(maxDate), [maxDate]);

  const totalDays = Math.max(
    1,
    Math.ceil((timelineEnd.getTime() - timelineStart.getTime()) / (1000 * 60 * 60 * 24))
  );

  const pxPerDay = zoom === 'week' ? 56 : zoom === 'day' ? 144 : zoom === 'hour' ? 288 : 1440;
  const timelineWidth = Math.max(1200, totalDays * pxPerDay);
  const timelineSpanMs = Math.max(1, timelineEnd.getTime() - timelineStart.getTime());

  // ── Horizontal virtualisation ──────────────────────────────────────────
  // Only day cells, time cells and bars near the visible scroll window are
  // rendered (one screen-width of buffer each side). A 90-day horizon at
  // Minute zoom was ~4,000 header cells plus days × lines of background.
  const [viewport, setViewport] = useState({ left: 0, width: 2400 });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setViewport((v) => (v.left === el.scrollLeft && v.width === el.clientWidth
        ? v
        : { left: el.scrollLeft, width: el.clientWidth || v.width }));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [zoom, totalDays]);
  const visFromPx = Math.max(0, viewport.left - viewport.width);
  const visToPx = viewport.left + viewport.width * 2;
  const firstVisDay = Math.min(totalDays, Math.max(0, Math.floor(visFromPx / pxPerDay)));
  const lastVisDay = Math.min(totalDays, Math.max(firstVisDay, Math.ceil(visToPx / pxPerDay)));
  const visStartMs = timelineStart.getTime() + firstVisDay * 86_400_000;
  const visEndMs = timelineStart.getTime() + lastVisDay * 86_400_000;

  // Lanes are one-per-WorkCentre (Production Line). Each lane id is a worcentreId;
  // every operation of that workcentre — whichever machine it is assigned to —
  // renders on the single workcentre lane.
  const workcentres = Array.from(new Set(resources.map((r) => r.worcentreId))).sort();

  // Distinct colour per workcentre (production line) for the "By workcentre"
  // colour mode. Assigned by the lane's sorted position so each line keeps a
  // stable, readable colour instead of every bar being the same blue.
  const wcColorById = useMemo(() => {
    const map: Record<string, string> = {};
    workcentres.forEach((wc, i) => {
      map[wc] = WORKCENTRE_PALETTE[i % WORKCENTRE_PALETTE.length];
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workcentres.join('|')]);

  // Lane metadata keyed by worcentreId. Kept under the historical name
  // `resourceMetaById` so existing lookups continue to resolve; here a "lane"
  // is a workcentre, so name === worcentreId.
  const resourceMetaById = useMemo(() => {
    const map: Record<string, { name: string; worcentreId: string }> = {};
    resources.forEach((resource) => {
      if (!map[resource.worcentreId]) {
        map[resource.worcentreId] = {
          name: resource.worcentreId,
          worcentreId: resource.worcentreId
        };
      }
    });
    return map;
  }, [resources]);

  const primaryLaneByWorkcentre = useMemo(() => {
    const map: Record<string, string> = {};
    resources.forEach((resource) => {
      if (!map[resource.worcentreId]) {
        map[resource.worcentreId] = resource.resourceId;
      }
    });
    return map;
  }, [resources]);

  // When a job is highlighted, build an ordered list of workcentres by operation sequence
  const highlightedJobWcOrder = useMemo(() => {
    if (!highlightJobId) return null;
    const matches = new Set<string>();
    const ordered: string[] = [];

    // Prefer the scheduled operation order if available
    if (schedule) {
      const js = schedule.jobSchedules.find(j => j.jobId === highlightJobId);
      if (js?.operationSchedules?.length) {
        const sorted = [...js.operationSchedules].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        for (const op of sorted) {
          const ids = [op.workcentreId, (op as any).resourceId ? String((op as any).resourceId) : ''].filter(Boolean);
          for (const id of ids) {
            if (!matches.has(id)) {
              matches.add(id);
              ordered.push(id);
            }
          }
        }
      }
    }

    // Fallback: use the job's planned operations
    const job = jobs?.find(j => j.jobId === highlightJobId);
    if (job?.operations?.length) {
      const sorted = [...job.operations].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      for (const op of sorted) {
        if (op.workcentreId && !matches.has(op.workcentreId)) {
          matches.add(op.workcentreId);
          ordered.push(op.workcentreId);
        }
      }
    }

    return ordered.length > 0 ? { set: matches, ordered } : null;
  }, [highlightJobId, schedule, jobs]);

  // All workcentre lanes stay visible at all times. When a job is highlighted we
  // only REORDER the lanes so the job's workcentres come first (in operation
  // order) — never hide the others.
  const visibleWorkcentres = highlightedJobWcOrder
    ? (() => {
        const orderIndex = new Map(highlightedJobWcOrder.ordered.map((wc, i) => [wc, i]));
        return [...workcentres].sort((a, b) => {
          const aIdx = orderIndex.get(a) ?? orderIndex.get(resourceMetaById[a]?.worcentreId || '') ?? 999;
          const bIdx = orderIndex.get(b) ?? orderIndex.get(resourceMetaById[b]?.worcentreId || '') ?? 999;
          return aIdx - bIdx;
        });
      })()
    : workcentres;

  // Every production line is always shown — selection/focus only highlights and
  // scrolls, it does not filter lanes out of the board.
  const displayWorkcentres = visibleWorkcentres;

  // Calendar per workcentre lane (representative = first resource of the workcentre).
  const workcentreCalendars = useMemo(() => {
    const map: Record<string, Resource['calendar']> = {};
    resources.forEach((resource) => {
      if (!map[resource.worcentreId]) {
        map[resource.worcentreId] = resource.calendar;
      }
    });
    return map;
  }, [resources]);

  // Now line position
  const nowPx = useMemo(() => {
    const now = Date.now();
    if (now < timelineStart.getTime() || now > timelineEnd.getTime()) return null;
    const days = (now - timelineStart.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0, days * pxPerDay);
  }, [timelineStart, timelineEnd, pxPerDay]);

  // Pixel offset for the start of today's date column (independent of clock time).
  // Used by the "Today" button so it always scrolls to the today column even when
  // the live "now" marker is outside the horizon.
  const todayStartPx = useMemo(() => {
    const todayMs = new Date(new Date().toDateString()).getTime(); // midnight local
    if (todayMs >= timelineEnd.getTime()) return 'after';   // today is past the horizon
    if (todayMs < timelineStart.getTime()) return 'before'; // today is before the horizon
    const days = (todayMs - timelineStart.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0, days * pxPerDay);
  }, [timelineStart, timelineEnd, pxPerDay]);

  // Utilization per machine and per workcentre group (booked productive hours / available capacity)
  const utilByWorkcentre = useMemo((): { machine: Record<string, number>; group: Record<string, number> } => {
    const empty = { machine: {}, group: {} };
    if (!schedule) return empty;

    const toMinutes = (value?: string): number => {
      const [hours, minutes] = String(value || '00:00').split(':').map((part) => Number(part) || 0);
      return Math.max(0, Math.min(1440, hours * 60 + minutes));
    };

    const getProductiveHours = (start: Date, end: Date, calendar?: Resource['calendar']): number => {
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;

      const workingDays = calendar?.workingDays || [1, 2, 3, 4, 5];
      const shift = (calendar?.shifts?.[0] || {}) as any;
      const isSchedulable = (diversion: any) => {
        if (typeof diversion?.schedulable === 'boolean') return diversion.schedulable;
        const key = String(diversion?.type || '').toLowerCase();
        return key.includes('production') || key.includes('overtime');
      };

      const productiveSlots = Array.isArray(shift.diversions) && shift.diversions.length
        ? [...shift.diversions]
            .filter((diversion: any) => isSchedulable(diversion))
            .sort((a: any, b: any) => toMinutes(a.startTime) - toMinutes(b.startTime))
        : [{ startTime: shift.startTime || '08:00', endTime: shift.endTime || '16:00' }];

      let totalMs = 0;
      const dayCursor = new Date(start);
      dayCursor.setHours(0, 0, 0, 0);
      const finalDay = new Date(end);
      finalDay.setHours(0, 0, 0, 0);

      while (dayCursor.getTime() <= finalDay.getTime()) {
        if (workingDays.includes(dayCursor.getDay())) {
          const dayStartMs = dayCursor.getTime();
          for (const slot of productiveSlots) {
            const segStartMs = dayStartMs + toMinutes(slot.startTime) * 60000;
            const segEndMs = dayStartMs + toMinutes(slot.endTime) * 60000;
            const overlapStart = Math.max(start.getTime(), segStartMs);
            const overlapEnd = Math.min(end.getTime(), segEndMs);
            if (overlapEnd > overlapStart) {
              totalMs += overlapEnd - overlapStart;
            }
          }
        }
        dayCursor.setDate(dayCursor.getDate() + 1);
      }

      return totalMs / (1000 * 60 * 60);
    };

    // Available hours per machine
    const availableHoursByLane: Record<string, number> = {};
    for (const wc of workcentres) {
      const calendar = workcentreCalendars[wc];
      const available = getProductiveHours(timelineStart, timelineEnd, calendar);
      availableHoursByLane[wc] = available > 0 ? available : Math.max(1, totalDays * ((calendar as any)?.workingHoursPerDay || 8));
    }

    // Booked hours per workcentre lane — clipped to the planning window so
    // utilization reflects only the visible interval, not the whole schedule
    // history. All machines of a workcentre roll up into that one lane.
    const bookedByLane: Record<string, number> = {};
    for (const js of schedule.jobSchedules) {
      for (const op of js.operationSchedules) {
        const rawStart = new Date((op as any).setupStart || op.plannedStartDate);
        const rawEnd   = new Date((op as any).runEnd   || op.plannedEndDate);
        // Clip to the visible planning window
        const clippedStart = rawStart < timelineStart ? new Date(timelineStart) : rawStart;
        const clippedEnd   = rawEnd   > timelineEnd   ? new Date(timelineEnd)   : rawEnd;
        if (clippedEnd.getTime() <= clippedStart.getTime()) continue; // entirely outside window
        const laneId = String(op.workcentreId);
        const rawSpanMs = rawEnd.getTime() - rawStart.getTime();
        const overlapFraction = rawSpanMs > 0
          ? (clippedEnd.getTime() - clippedStart.getTime()) / rawSpanMs
          : 1;
        const bookedHours =
          getProductiveHours(clippedStart, clippedEnd, workcentreCalendars[laneId]) ||
          ((Number(op.duration) || 0) / 60) * overlapFraction;
        bookedByLane[laneId] = (bookedByLane[laneId] || 0) + bookedHours;
      }
    }

    // Per-workcentre utilization %. machine and group are the same map now that
    // a lane IS a workcentre; both keys are kept for the existing render code.
    const util: Record<string, number> = {};
    for (const wc of workcentres) {
      const availableHours = availableHoursByLane[wc] || 1;
      util[wc] = Math.min(100, Math.round(((bookedByLane[wc] || 0) / availableHours) * 100));
    }

    return { machine: util, group: util };
  }, [schedule, workcentres, totalDays, workcentreCalendars, timelineStart, timelineEnd]);

  // Job due dates map
  const jobDueDates = useMemo(() => {
    const map: Record<string, Date> = {};
    if (!schedule) return map;
    // We don't have direct job due dates in schedule, use end date as proxy
    for (const js of schedule.jobSchedules) {
      map[js.jobId] = new Date(js.plannedEndDate);
    }
    return map;
  }, [schedule]);

  const toggleLock = useCallback((jobId: string, opId: string) => {
    const key = `${jobId}::${opId}`;
    setLockedOps((prev) => {
      const newLocked = !prev[key];
      onLockChange?.(key, newLocked);
      return { ...prev, [key]: newLocked };
    });
  }, [onLockChange]);

  const showTooltip = useCallback((e: React.MouseEvent, content: React.ReactNode) => {
    setTooltip({ visible: true, x: e.clientX + 10, y: e.clientY + 10, content });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Open the context menu in response to a right-click on an operation bar.
  const openContextMenu = useCallback(
    (e: React.MouseEvent, jobId: string, opId: string, isLocked: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      // Clamp to viewport so the menu never overflows.
      const margin = 8;
      const menuW = 220;
      const menuH = 140;
      const x = Math.min(window.innerWidth - menuW - margin, e.clientX);
      const y = Math.min(window.innerHeight - menuH - margin, e.clientY);
      setContextMenu({ visible: true, x, y, jobId, opId, isLocked });
      hideTooltip();
    },
    [hideTooltip]
  );

  // Auto-close on outside click / scroll / Esc.
  React.useEffect(() => {
    if (!contextMenu?.visible) return;
    const onDoc = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    window.addEventListener('click', onDoc);
    window.addEventListener('scroll', onDoc, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDoc);
      window.removeEventListener('scroll', onDoc, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu?.visible, closeContextMenu]);

  // Escape clears multi-select (Arrow key nudge is placed after laneOperations declaration below)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedOps.size > 0) {
        setSelectedOps(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedOps.size]);

  const laneOperations = useMemo(() => {
    if (!schedule) return [];
    const winStart = timelineStart.getTime();
    const winEnd   = timelineEnd.getTime();
    return schedule.jobSchedules.flatMap((jobSchedule) =>
      jobSchedule.operationSchedules
        .filter((op) => {
          const opStart = new Date((op as any).setupStart || op.plannedStartDate).getTime();
          const opEnd   = new Date((op as any).moveEnd   || op.plannedEndDate).getTime();
          // Keep operation only if it overlaps the visible window
          return opEnd > winStart && opStart < winEnd;
        })
        .map((op) => ({ ...op, jobId: jobSchedule.jobId }))
    );
  }, [schedule, timelineStart, timelineEnd]);

  // One pass instead of filtering every op for every line, and an O(1) job
  // status lookup instead of a jobSchedules.find() per bar.
  const opsByWorkcentre = useMemo(() => {
    const map = new Map<string, typeof laneOperations>();
    for (const op of laneOperations) {
      const key = String(op.workcentreId);
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(op);
    }
    return map;
  }, [laneOperations]);
  const jobStatusById = useMemo(
    () => new Map((schedule?.jobSchedules || []).map((j) => [j.jobId, j.status] as const)),
    [schedule]
  );

  // S3.3: Arrow key nudge — must be after laneOperations is declared
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selectedOps.size > 0 && onOperationMove) {
        e.preventDefault();
        const deltaMs = e.shiftKey
          ? 60 * 60 * 1000          // Shift+Arrow = ±1 hour
          : 24 * 60 * 60 * 1000;   // Arrow = ±1 day
        const sign = e.key === 'ArrowRight' ? 1 : -1;
        for (const key of selectedOps) {
          const [jobId, opId] = key.split('::');
          const op = laneOperations.find(o => o.jobId === jobId && o.opId === opId);
          if (!op) continue;
          const newStart = new Date(new Date(op.plannedStartDate).getTime() + sign * deltaMs);
          onOperationMove(jobId, opId, newStart, op.workcentreId);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedOps, laneOperations, onOperationMove]);

  // Fast job lookup by id for tooltip enrichment
  const jobsById = useMemo(() => {
    const map = new Map<string, Job>();
    for (const j of (jobs ?? [])) map.set(j.jobId, j);
    return map;
  }, [jobs]);

  // ── Master/sub-job dependencies (SYSPRO WipMasterSub) ─────────────────────
  // sub jobId → master jobId, resolved against the loaded jobs.
  const parentMap = useMemo(() => buildParentMap(jobs ?? []), [jobs]);

  /** 'master' | 'sub' | 'both' per jobId — drives the M/S badge on bars. */
  const depRoleByJobId = useMemo(() => {
    const masters = new Set<string>();
    const subs = new Set<string>();
    parentMap.forEach((master, sub) => {
      masters.add(master);
      subs.add(sub);
    });
    const map = new Map<string, 'master' | 'sub' | 'both'>();
    masters.forEach((id) => map.set(id, subs.has(id) ? 'both' : 'master'));
    subs.forEach((id) => {
      if (!map.has(id)) map.set(id, 'sub');
    });
    return map;
  }, [parentMap]);

  // Defined before handleDragOver because the drag handler uses it for ghost-bar segmentation.
  const getProductiveDisplaySegments = useCallback((
    start: Date,
    end: Date,
    calendar: Resource['calendar'] | undefined,
  ): Array<{ start: Date; end: Date }> => {
    if (end.getTime() <= start.getTime()) return [];

    const workingDays = calendar?.workingDays || [1, 2, 3, 4, 5];
    const shift = (calendar?.shifts?.[0] || {}) as any;
    const isSchedulable = (diversion: any) => {
      if (typeof diversion?.schedulable === 'boolean') return diversion.schedulable;
      const key = String(diversion?.type || '').toLowerCase();
      return key.includes('production') || key.includes('overtime');
    };

    const productiveDiversions = Array.isArray(shift.diversions)
      ? [...shift.diversions]
          .filter((diversion: any) => isSchedulable(diversion))
          .sort((a: any, b: any) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
      : [];

    const segments: Array<{ start: Date; end: Date }> = [];
    const dayCursor = new Date(start);
    dayCursor.setHours(0, 0, 0, 0);
    const finalDay = new Date(end);
    finalDay.setHours(0, 0, 0, 0);

    while (dayCursor.getTime() <= finalDay.getTime()) {
      if (workingDays.includes(dayCursor.getDay())) {
        const dayStartMs = dayCursor.getTime();

        if (productiveDiversions.length) {
          for (const diversion of productiveDiversions) {
            const segStartMs = dayStartMs + timeToMinutes(diversion.startTime) * 60000;
            const segEndMs = dayStartMs + timeToMinutes(diversion.endTime) * 60000;
            const overlapStart = Math.max(start.getTime(), segStartMs);
            const overlapEnd = Math.min(end.getTime(), segEndMs);
            if (overlapEnd > overlapStart) {
              segments.push({ start: new Date(overlapStart), end: new Date(overlapEnd) });
            }
          }
        } else {
          const segStartMs = dayStartMs + timeToMinutes(shift.startTime || '08:00') * 60000;
          const segEndMs = dayStartMs + timeToMinutes(shift.endTime || '16:00') * 60000;
          const overlapStart = Math.max(start.getTime(), segStartMs);
          const overlapEnd = Math.min(end.getTime(), segEndMs);
          if (overlapEnd > overlapStart) {
            segments.push({ start: new Date(overlapStart), end: new Date(overlapEnd) });
          }
        }
      }
      dayCursor.setDate(dayCursor.getDate() + 1);
    }

    return segments.length ? segments : [{ start, end }];
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>, laneWc: string) => {
    // Determine if drop is allowed (operations locked to their assigned machine)
    let canDrop = true;
    const dragged = draggedItemRef.current;
    if (dragged && dragged.type === 'operation') {
      const job = jobs?.find(j => j.jobId === dragged.jobId);
      const op = job?.operations?.find(o => o.opId === dragged.opId);
      if (op && op.workcentreId !== laneWc) {
        canDrop = false;
      }
    }

    if (canDrop) {
      e.preventDefault(); // only allow drop on correct machine
    }

    // Compute date from cursor position
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const dropDate = new Date(timelineStart.getTime() + timelineSpanMs * ratio);

    // Build preview data
    let jobId = '';
    let jobType = '';
    let opSeq = '';
    let opDesc = '';
    let stockCode = '';
    let stockDesc = '';
    let endDate: Date | null = null;

    if (dragged) {
      jobId = dragged.jobId;
      const job = jobs?.find(j => j.jobId === dragged.jobId);
      if (job) {
        jobType = String((job as any).Type || '');
        stockCode = job.itemCode || '';
        stockDesc = String((job as any).StockDescription || '');
      }
      if (dragged.type === 'operation') {
        const scheduledOp = laneOperations.find(o => o.jobId === dragged.jobId && o.opId === dragged.opId);
        const origOp = job?.operations?.find(o => o.opId === dragged.opId);
        if (origOp) {
          opSeq = String(origOp.sequence || '');
          opDesc = String((origOp as any).Description || origOp.workcentreName || '');
        }
        if (scheduledOp) {
          opSeq = opSeq || String((scheduledOp as any).sequence || '');
          const previewStart = new Date((scheduledOp as any).setupStart || scheduledOp.plannedStartDate);
          const previewEnd = new Date((scheduledOp as any).runEnd || scheduledOp.plannedEndDate);
          const opSpanMs = previewEnd.getTime() - previewStart.getTime();
          endDate = new Date(dropDate.getTime() + opSpanMs);
        }
      }
    } else if (highlightJobId) {
      // Job being dragged from the jobs table
      jobId = highlightJobId;
      const job = jobs?.find(j => j.jobId === highlightJobId);
      if (job) {
        jobType = String((job as any).Type || '');
        stockCode = job.itemCode || '';
        stockDesc = String((job as any).StockDescription || '');
        const firstOp = job.operations?.[0];
        if (firstOp) {
          opSeq = String(firstOp.sequence || '');
          opDesc = String((firstOp as any).Description || firstOp.workcentreName || '');
          const totalMs = ((firstOp.setupTime || 0) + (firstOp.duration || 0)) * 60000;
          endDate = new Date(dropDate.getTime() + totalMs);
        }
      }
    }

    setDragPreview({
      visible: true, x: e.clientX + 16, y: e.clientY - 160,
      date: dropDate, endDate, jobId, jobType, opSeq, opDesc, stockCode, stockDesc, canDrop
    });

    // --- Ghost bars: show pixel-positions for ALL operations of the dragged job ---
    const ghostJobId = dragged?.jobId || highlightJobId || '';
    if (ghostJobId) {
      const jobSched = schedule?.jobSchedules.find(j => j.jobId === ghostJobId);
      if (jobSched?.operationSchedules?.length) {
        const sortedOps = [...jobSched.operationSchedules].sort(
          (a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime()
        );
        // Anchor: for single-op drag use that op; for job drag use first op
        const anchorOp =
          dragged?.type === 'operation' && dragged.opId
            ? sortedOps.find(o => o.opId === dragged.opId) ?? sortedOps[0]
            : sortedOps[0];
        const anchorMs = new Date((anchorOp as any).setupStart || anchorOp.plannedStartDate).getTime();
        // For op drags: subtract grab offset so ghost bar moves WITH the cursor, not left-edge → cursor
        const grabOffsetMs = dragged?.type === 'operation' ? (dragAnchorRef.current?.grabOffsetMs ?? 0) : 0;
        const deltaMs  = (dropDate.getTime() - grabOffsetMs) - anchorMs;
        const pxPerMs  = pxPerDay / (1000 * 60 * 60 * 24);

        // Build ghost bars using the same productive-segment logic as real bars so
        // the ghost width matches the rendered bar width exactly (no non-working gaps).
        const newBars: GhostBar[] = sortedOps.flatMap(op => {
          const gStart = new Date(new Date((op as any).setupStart || op.plannedStartDate).getTime() + deltaMs);
          const gEnd   = new Date(new Date((op as any).runEnd   || op.plannedEndDate  ).getTime() + deltaMs);
          const laneId = String(op.workcentreId);
          const label  = `Op ${(op as any).sequence ?? op.opId}`;
          const wcId   = String((op as any).workcentreId || '');
          const calendar = workcentreCalendars[wcId];

          // Use the same productive-segment function as the real bars to get segments
          // that skip non-working time — this makes the ghost match the real bar width.
          const segments = getProductiveDisplaySegments(gStart, gEnd, calendar);

          return segments.map((seg, segIdx) => {
            const left  = Math.max(0, Math.min(timelineWidth, (seg.start.getTime() - timelineStart.getTime()) * pxPerMs));
            const width = Math.max(12, (seg.end.getTime() - seg.start.getTime()) * pxPerMs);
            return { key: `${ghostJobId}::${op.opId}::${segIdx}`, laneId, left, width, label };
          });
        });
        setGhostBars(newBars);
      } else {
        setGhostBars([]);
      }
    } else {
      setGhostBars([]);
    }
  }, [timelineStart, timelineSpanMs, jobs, highlightJobId, laneOperations, schedule, primaryLaneByWorkcentre, pxPerDay, timelineWidth, workcentreCalendars, getProductiveDisplaySegments]);

  const handleDragLeave = useCallback(() => {
    setDragPreview(prev => ({ ...prev, visible: false }));
    setGhostBars([]);
  }, []);

  const calculatePosition = (date: Date): number => {
    const days = (date.getTime() - timelineStart.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(timelineWidth, days * pxPerDay));
  };

  const handleZoomWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const levels: Array<'week' | 'day' | 'hour' | 'minute'> = ['week', 'day', 'hour', 'minute'];
    const currentIndex = levels.indexOf(zoom);
    if (e.deltaY < 0 && currentIndex < levels.length - 1) {
      setZoom(levels[currentIndex + 1]);
    } else if (e.deltaY > 0 && currentIndex > 0) {
      setZoom(levels[currentIndex - 1]);
    }
  }, [zoom]);

  const calculateWidth = (startDate: Date, endDate: Date): number => {
    const days = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(12, days * pxPerDay);
  };

  const getCalendarDayBackground = useCallback((calendar: Resource['calendar'] | undefined, day: Date): string => {
    const offColor = 'rgba(226,232,240,0.72)';
    const shiftOffColor = 'rgba(220,230,245,0.25)';
    const workingDays = calendar?.workingDays || [1, 2, 3, 4, 5];
    if (!workingDays.includes(day.getDay())) {
      return offColor;
    }

    const shift = (calendar?.shifts?.[0] || {}) as any;
    const getTypeColor = (type?: string, schedulable?: boolean) => {
      const key = String(type || '').toLowerCase();
      if (key.includes('overtime')) return 'rgba(147,197,253,0.55)';
      if (key.includes('lunch')) return 'rgba(253,230,138,0.7)';
      if (key.includes('break')) return 'rgba(252,211,77,0.7)';
      if (key.includes('non')) return 'rgba(180,180,180,0.55)';
      return schedulable === false ? 'rgba(180,180,180,0.55)' : 'rgba(134,239,172,0.55)';
    };

    const pushRange = (stops: string[], color: string, start: number, end: number) => {
      if (end <= start) return;
      stops.push(`${color} ${start}%`, `${color} ${end}%`);
    };

    const diversions = Array.isArray(shift.diversions)
      ? [...shift.diversions].sort((a: any, b: any) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
      : [];

    if (!diversions.length) {
      const startPct = (timeToMinutes(shift.startTime || '08:00') / 1440) * 100;
      const endPct = (timeToMinutes(shift.endTime || '16:00') / 1440) * 100;
      return `linear-gradient(90deg, ${shiftOffColor} 0%, ${shiftOffColor} ${startPct}%, rgba(134,239,172,0.55) ${startPct}%, rgba(134,239,172,0.55) ${endPct}%, ${shiftOffColor} ${endPct}%, ${shiftOffColor} 100%)`;
    }

    const stops: string[] = [];
    let cursor = 0;
    for (const diversion of diversions) {
      const start = Math.max(cursor, timeToMinutes(diversion.startTime));
      const end = Math.max(start, timeToMinutes(diversion.endTime));
      pushRange(stops, shiftOffColor, (cursor / 1440) * 100, (start / 1440) * 100);
      pushRange(stops, getTypeColor(diversion.type, diversion.schedulable), (start / 1440) * 100, (end / 1440) * 100);
      cursor = end;
    }
    pushRange(stops, shiftOffColor, (cursor / 1440) * 100, 100);
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }, []);

  const daySlots = useMemo(() => {
    return Array.from({ length: totalDays }).map((_, i) => addDays(timelineStart, i));
  }, [totalDays, timelineStart]);

  const timeSlots = useMemo(() => {
    const stepHours = zoom === 'minute' ? 0.5 : zoom === 'hour' ? 2 : zoom === 'day' ? 4 : 24;
    const totalHours = totalDays * 24;
    const slots: Date[] = [];
    for (let h = 0; h < totalHours; h += stepHours) {
      slots.push(new Date(timelineStart.getTime() + h * 3600000));
    }
    return slots;
  }, [zoom, totalDays, timelineStart]);

  const weekSlots = useMemo(() => {
    const weeks: { start: Date; days: number }[] = [];
    let cursor = timelineStart;
    while (cursor < timelineEnd) {
      const nextMonday = addDays(startOfWeek(cursor, { weekStartsOn: 1 }), 7);
      const weekEnd = nextMonday < timelineEnd ? nextMonday : timelineEnd;
      const days = Math.ceil((weekEnd.getTime() - cursor.getTime()) / (1000 * 60 * 60 * 24));
      if (days > 0) weeks.push({ start: cursor, days });
      cursor = weekEnd;
    }
    return weeks;
  }, [timelineStart, timelineEnd]);

  // Compute sub-row indices to avoid visual overlap within each workcentre lane
  const subRowMap = useMemo(() => {
    const map: Record<string, number> = {};
    const maxRows: Record<string, number> = {};
    for (const wc of workcentres) {
      // wc is a worcentreId — every op of that workcentre stacks on this one lane.
      const ops = laneOperations
        .filter(op => String(op.workcentreId) === wc)
        .sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime());

      const rowEnds: number[] = [];
      let maxRow = 0;

      for (const op of ops) {
        const opStart = new Date(op.plannedStartDate).getTime();
        const opEnd = new Date(op.plannedEndDate).getTime();

        let assignedRow = -1;
        for (let r = 0; r < rowEnds.length; r++) {
          if (rowEnds[r] <= opStart) {
            assignedRow = r;
            break;
          }
        }

        if (assignedRow === -1) {
          assignedRow = rowEnds.length;
          rowEnds.push(opEnd);
        } else {
          rowEnds[assignedRow] = opEnd;
        }

        map[`${op.jobId}::${op.opId}`] = assignedRow;
        maxRow = Math.max(maxRow, assignedRow);
      }

      maxRows[wc] = maxRow;
    }

    return { map, maxRows };
  }, [laneOperations, workcentres]);

  // ── Dependency link geometry ───────────────────────────────────────────────
  // Vertical layout mirrors the render loop: each machine row's height derives
  // from its sub-row count, +1px for the row's border-bottom.
  const laneGeometry = useMemo(() => {
    const map = new Map<string, { top: number; height: number }>();
    let top = 0;
    for (const wc of displayWorkcentres) {
      const height = Math.max(22, ((subRowMap.maxRows[wc] || 0) + 1) * prefs.rowHeight + 2);
      map.set(wc, { top, height });
      top += height + 1;
    }
    return { map, totalHeight: top };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayWorkcentres.join('|'), subRowMap, prefs.rowHeight]);

  /**
   * Sub-job → master dependency arrows, drawn for the highlighted job's whole
   * family only (keeps the board readable). Each link runs from the sub-job's
   * last operation end to the master's first operation start.
   */
  const dependencyLinks = useMemo(() => {
    if (!highlightJobId || !schedule || parentMap.size === 0) return [];

    const rootId = getMasterRootJobId(highlightJobId, parentMap);
    const familyIds = new Set<string>([rootId]);
    parentMap.forEach((_master, sub) => {
      if (getMasterRootJobId(sub, parentMap) === rootId) familyIds.add(sub);
    });
    if (!familyIds.has(highlightJobId) || familyIds.size < 2) return [];

    const laneOf = (op: any): string => String(op.workcentreId);
    const pxPerMs = pxPerDay / (1000 * 60 * 60 * 24);
    const xOf = (date: Date): number =>
      Math.max(0, Math.min(timelineWidth, (date.getTime() - timelineStart.getTime()) * pxPerMs));
    const barCenterY = (laneTop: number, jobId: string, opId: string): number =>
      laneTop + 1 + (subRowMap.map[`${jobId}::${opId}`] || 0) * prefs.rowHeight + 9;

    const links: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; sub: string; master: string; violated: boolean }> = [];
    parentMap.forEach((master, sub) => {
      if (!familyIds.has(sub) || !familyIds.has(master)) return;
      const subSched = schedule.jobSchedules.find((j) => j.jobId === sub);
      const masterSched = schedule.jobSchedules.find((j) => j.jobId === master);
      if (!subSched?.operationSchedules?.length || !masterSched?.operationSchedules?.length) return;

      const subLast = [...subSched.operationSchedules].sort(
        (a, b) => new Date(b.plannedEndDate).getTime() - new Date(a.plannedEndDate).getTime()
      )[0];
      const masterFirst = [...masterSched.operationSchedules].sort(
        (a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime()
      )[0];

      const subLane = laneGeometry.map.get(laneOf(subLast));
      const masterLane = laneGeometry.map.get(laneOf(masterFirst));
      if (!subLane || !masterLane) return; // lane filtered out of view

      const subEnd = new Date(subLast.plannedEndDate);
      const masterStart = new Date(masterFirst.plannedStartDate);
      links.push({
        key: `${sub}->${master}`,
        x1: xOf(subEnd),
        y1: barCenterY(subLane.top, sub, String(subLast.opId)),
        x2: xOf(masterStart),
        y2: barCenterY(masterLane.top, master, String(masterFirst.opId)),
        sub,
        master,
        violated: subEnd.getTime() > masterStart.getTime(),
      });
    });
    return links;
  }, [highlightJobId, schedule, parentMap, laneGeometry, subRowMap, prefs.rowHeight, primaryLaneByWorkcentre, pxPerDay, timelineWidth, timelineStart]);

  const getOpColor = (op: typeof laneOperations[0]): string => {
    if (colorMode === 'workcentre') {
      return wcColorById[op.workcentreId] || '#4f8bff';
    }
    if (colorMode === 'lateness') {
      const lateness = getLateness(new Date(op.plannedEndDate), jobDueDates[op.jobId]);
      return getLatenessColor(lateness);
    }
    if (colorMode === 'status') {
      const jobSchedule = schedule?.jobSchedules.find(j => j.jobId === op.jobId);
      if (jobSchedule?.status === 'ConstraintViolation') return '#ef4444';
      if (jobSchedule?.status === 'Unschedulable') return '#6b7280';
      return '#10b981';
    }
    if (colorMode === 'critical') {
      // Highlight jobs with 0 or negative slack as critical
      if (op.slackTime !== undefined && op.slackTime <= 0) return '#ef4444';
      if (op.slackTime !== undefined && op.slackTime < 60) return '#f59e0b';
      return '#3e7fe7';
    }
    return '#3e7fe7';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, workcentreId: string, machineId?: string) => {
    e.preventDefault();
    draggedItemRef.current = null;
    setGhostBars([]);
    setDragPreview(prev => ({ ...prev, visible: false }));
    const opKey = e.dataTransfer.getData('text/op-key');
    const jobId = e.dataTransfer.getData('text/job-id');

    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const dropDate = new Date(timelineStart.getTime() + timelineSpanMs * ratio);

    if (opKey && onOperationMove) {
      const [movedJobId, movedOpId] = opKey.split('::');
      if (movedJobId && movedOpId) {
        const opKey2 = `${movedJobId}::${movedOpId}`;
        if (lockedOps[opKey2]) return;

        // Multi-select group move: apply the same delta to all selected ops
        if (selectedOps.size > 1 && selectedOps.has(opKey2) && dragAnchorRef.current) {
          const anchor = dragAnchorRef.current;
          const deltaMs = dropDate.getTime() - anchor.origStartMs;
          for (const selKey of selectedOps) {
            if (lockedOps[selKey]) continue;
            const [sJobId, sOpId] = selKey.split('::');
            if (!sJobId || !sOpId) continue;
            const selOp = laneOperations.find(o => o.jobId === sJobId && o.opId === sOpId);
            if (!selOp) continue;
            const newStart = new Date(new Date(selOp.plannedStartDate).getTime() + deltaMs);
            onOperationMove(sJobId, sOpId, newStart, selOp.workcentreId);
          }
          dragAnchorRef.current = null;
          return;
        }

        // Single op move — stays within its workcentre, but CAN switch to a
        // different machine lane of the same workcentre (S3.3). The target
        // machine id is forwarded so App can reassign resourceId.
        const sourceOp = laneOperations.find(o => o.jobId === movedJobId && o.opId === movedOpId);
        if (sourceOp && sourceOp.workcentreId !== workcentreId) return;
        onOperationMove(movedJobId, movedOpId, dropDate, workcentreId, machineId);
        dragAnchorRef.current = null;
        return;
      }
    }

    if (!jobId) return;
    onJobDrop(jobId, dropDate, workcentreId, machineId);
  };

  if (loading) {
    return <div className="machine-gantt loading">Loading schedule board...</div>;
  }

  if (workcentres.length === 0) {
    return <div className="machine-gantt empty">Load resources to show machine lanes.</div>;
  }

  return (
    <div className="machine-gantt" ref={ganttRef} onWheel={handleZoomWheel}>
      {/* Floating tooltip */}
      <GanttTooltip visible={tooltip.visible} x={tooltip.x} y={tooltip.y} content={tooltip.content} />
      {/* Right-click context menu */}
      <GanttContextMenu
        contextMenu={contextMenu}
        highlightJobId={highlightJobId}
        onClose={closeContextMenu}
        onShowMaterials={(id) => onShowMaterials?.(id)}
        onHighlightJob={(id) => onHighlightJob?.(id)}
        onToggleLock={toggleLock}
      />
      {/* Drag preview card */}
      <DragPreview dragPreview={dragPreview} />
      {/* Legend overlay */}
      <GanttLegend
        show={showLegend}
        colorMode={colorMode}
        workcentres={workcentres}
        onClose={() => setShowLegend(false)}
      />
      <div className="machine-gantt-header">
        <div>
          <h3>Schedule Board</h3>
          <p>Drag jobs/ops onto machine lanes. Ctrl+Click bars to multi-select, then drag to move the group. Hold Ctrl and scroll to zoom.</p>
        </div>
        <div className="gantt-toolbar">
          <div className="gantt-toolbar-group">
            <span className="gantt-toolbar-label">Color:</span>
            <select className="gantt-select" value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
              <option value="workcentre">Workcentre</option>
              <option value="lateness">Lateness</option>
              <option value="status">Job Status</option>
              <option value="critical">Critical Path</option>
            </select>
          </div>
          <div className="gantt-toolbar-group">
            <span className="gantt-toolbar-label">Zoom:</span>
            <button className={`zoom-btn ${zoom === 'week' ? 'active' : ''}`} onClick={() => setZoom('week')}>Week</button>
            <button className={`zoom-btn ${zoom === 'day' ? 'active' : ''}`} onClick={() => setZoom('day')}>Day</button>
            <button className={`zoom-btn ${zoom === 'hour' ? 'active' : ''}`} onClick={() => setZoom('hour')}>Hour</button>
            <button className={`zoom-btn ${zoom === 'minute' ? 'active' : ''}`} onClick={() => setZoom('minute')}>Minute</button>
          </div>
          <button className={`zoom-btn ${showUtilBars ? 'active' : ''}`} onClick={() => setShowUtilBars(v => !v)} title="Toggle utilization bars">📊 Util</button>
          <button className="zoom-btn" onClick={timeFenceLock} title="Lock every operation starting in the next N days (time fence)">🔒 Time fence</button>
          <button className="zoom-btn" onClick={clearLocks} title="Remove all locks">🔓 Clear locks</button>
          <button className={`zoom-btn ${showShift ? 'active' : ''}`} onClick={() => setShowShift(v => !v)} title="Toggle shift info">⏱ Shift</button>
          <button
            className={`zoom-btn today-btn${todayStartPx === 'before' || todayStartPx === 'after' ? ' today-btn-out' : ''}`}
            onClick={() => {
              if (!gridRef.current) return;
              const leftCols = prefs.wcColWidth + prefs.machineColWidth;
              if (todayStartPx === 'before') {
                gridRef.current.scrollLeft = 0;
              } else if (todayStartPx === 'after') {
                gridRef.current.scrollLeft = gridRef.current.scrollWidth;
              } else {
                gridRef.current.scrollLeft = Math.max(0, (todayStartPx as number) - (gridRef.current.clientWidth - leftCols) / 2);
              }
            }}
            title={
              todayStartPx === 'before' ? 'Today is before this schedule — scrolling to start'
              : todayStartPx === 'after' ? 'Today is past this schedule — scrolling to end'
              : 'Scroll to today'
            }
          >📍 Today</button>
          <button className="zoom-btn" onClick={() => setShowLegend(v => !v)} title="Toggle legend">🔑 Legend</button>
          {selectedOps.size > 1 && (
            <span className="gantt-multiselect-badge" title={`${selectedOps.size} ops selected — drag any to move group. Press Esc to clear.`}>
              ✦ {selectedOps.size} selected
              <button
                className="gantt-multiselect-clear"
                onClick={() => setSelectedOps(new Set())}
                aria-label="Clear selection"
              >✕</button>
            </span>
          )}
        </div>
      </div>

      {/* Production-line legend — one colour chip per line with live utilisation. */}
      {colorMode === 'workcentre' && displayWorkcentres.length > 0 && (
        <div className="gantt-line-legend">
          <span className="gantt-line-legend__title">Lines</span>
          {displayWorkcentres.map((wc) => {
            const wcId = resourceMetaById[wc]?.worcentreId || wc;
            const util = utilByWorkcentre.group[wcId] || 0;
            const color = wcColorById[wcId] || '#4f8bff';
            const active = selectedWorkcentre === wcId;
            return (
              <button
                key={`legend-${wc}`}
                className={`gantt-line-chip${active ? ' active' : ''}`}
                style={{ ['--chip' as any]: color }}
                onClick={() => setSelectedWorkcentre((prev) => (prev === wcId ? null : wcId))}
                title={`${wcId} — ${util}% loaded${active ? ' (highlighted)' : ''}`}
              >
                <span className="gantt-line-chip__dot" />
                <span className="gantt-line-chip__id">{wcId}</span>
                {util > 0 && <span className="gantt-line-chip__util">{util}%</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="machine-gantt-grid" ref={gridRef}>
        <div className="machine-timeline-header">
          <div className="wc-col-label" style={{ width: prefs.wcColWidth, minWidth: prefs.wcColWidth }}>WC</div>
          <div className="machine-col-label" style={{ width: prefs.machineColWidth, minWidth: prefs.machineColWidth }}>Production Line</div>
          <div className="timeline-rows" style={{ width: timelineWidth }}>
            <div className="timeline-week-row">
              {weekSlots.map((w, i) => (
                <div key={i} className="week-cell" style={{ width: w.days * pxPerDay, minWidth: w.days * pxPerDay }}>
                  {format(w.start, "'W'II · MMM yyyy")}
                </div>
              ))}
            </div>
            <div className="timeline-date-row">
              <div className="gantt-virtual-spacer" style={{ width: firstVisDay * pxPerDay }} />
              {daySlots.slice(firstVisDay, lastVisDay).map((date, j) => {
                const i = firstVisDay + j;
                const isToday = format(date, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                return (
                  <div key={i} className={`date-cell${isToday ? ' today-date-cell' : ''}`} style={{ width: pxPerDay, minWidth: pxPerDay }}>
                    {format(date, 'EEE. dd MMM')}
                  </div>
                );
              })}
            </div>
            <div className="timeline-time-row">
              <div className="gantt-virtual-spacer" style={{ width: firstVisDay * pxPerDay }} />
              {timeSlots.filter((d) => d.getTime() >= visStartMs && d.getTime() < visEndMs).map((date) => {
                const stepHours = zoom === 'minute' ? 0.5 : zoom === 'hour' ? 2 : zoom === 'day' ? 4 : 24;
                const slotWidth = (stepHours / 24) * pxPerDay;
                const i = date.getTime();
                return (
                  <div key={i} className="time-cell" style={{ width: slotWidth, minWidth: slotWidth }}>
                    {zoom === 'week' ? format(date, 'EEE') : format(date, 'HH:mm')}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="machine-lanes" style={{ position: 'relative' }}>
          {/* Master/sub dependency arrows — drawn for the highlighted family */}
          {dependencyLinks.length > 0 && (
            <svg
              className="gantt-dep-overlay"
              width={prefs.wcColWidth + prefs.machineColWidth + timelineWidth}
              height={laneGeometry.totalHeight}
              aria-hidden="true"
            >
              <defs>
                <marker id="gantt-dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--accent, #4f8bff)" />
                </marker>
                <marker id="gantt-dep-arrow-violated" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--status-error, #ef4444)" />
                </marker>
              </defs>
              {dependencyLinks.map((link) => {
                const labelOffset = prefs.wcColWidth + prefs.machineColWidth;
                const x1 = labelOffset + link.x1;
                const x2 = labelOffset + link.x2;
                const midX = x1 + Math.max(14, (x2 - x1) / 2);
                const stroke = link.violated ? 'var(--status-error, #ef4444)' : 'var(--accent, #4f8bff)';
                return (
                  <g key={link.key} className="gantt-dep-link">
                    <title>{`Sub-job ${link.sub} must finish before master ${link.master} starts${link.violated ? ' — VIOLATED' : ''}`}</title>
                    <path
                      d={`M ${x1} ${link.y1} L ${midX} ${link.y1} L ${midX} ${link.y2} L ${x2} ${link.y2}`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={1.5}
                      strokeDasharray={link.violated ? '3 3' : '6 3'}
                      markerEnd={link.violated ? 'url(#gantt-dep-arrow-violated)' : 'url(#gantt-dep-arrow)'}
                      opacity={0.9}
                    />
                    <circle cx={x1} cy={link.y1} r={2.5} fill={stroke} />
                  </g>
                );
              })}
            </svg>
          )}
          {displayWorkcentres.map((wc) => {
            const util = utilByWorkcentre.machine[wc] || 0;
            const wcId = resourceMetaById[wc]?.worcentreId || wc;
            const wcGroupUtil = utilByWorkcentre.group[wcId] || 0;
            const utilColor = (pct: number) => pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
            return (
              <div className="machine-row" key={wc} style={{ minHeight: Math.max(22, ((subRowMap.maxRows[wc] || 0) + 1) * prefs.rowHeight + 2) }}>
                <div
                  className={`wc-cell${selectedWorkcentre === wcId ? ' active' : ''}`}
                  onClick={() => setSelectedWorkcentre(prev => prev === wcId ? null : wcId)}
                  style={{ width: prefs.wcColWidth, minWidth: prefs.wcColWidth, left: 0, borderLeft: `4px solid ${wcColorById[wcId] || '#4f8bff'}` }}
                  title={selectedWorkcentre === wcId ? 'Click to clear highlight' : `Click to highlight line ${wcId}`}
                  data-wc-id={wcId}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: wcColorById[wcId] || '#4f8bff', flexShrink: 0 }} />
                    {wcId}
                  </span>
                  {wcGroupUtil > 0 && (
                    <span style={{ fontSize: 9, color: utilColor(wcGroupUtil), fontWeight: 700, marginTop: 1 }}>{wcGroupUtil}%</span>
                  )}
                </div>
                <div className="machine-name" style={{ width: prefs.machineColWidth, minWidth: prefs.machineColWidth, left: prefs.wcColWidth }}>
                  <strong>{wcId}</strong>
                  <span>Production Line</span>
                  {showShift && (
                    <span>
                      {workcentreCalendars[wc]?.shifts?.[0]
                        ? `${workcentreCalendars[wc].shifts[0].name} • ${Math.round(((workcentreCalendars[wc] as any)?.workingHoursPerDay || 0) * 10) / 10}h productive`
                        : 'Default shift'}
                    </span>
                  )}
                  {showUtilBars && (
                    <div className="util-bar-wrap" title={`${util}% utilisation`}>
                      <div className="util-bar" style={{ width: `${util}%`, background: utilColor(util) }} />
                      <span className="util-label">{util}%</span>
                    </div>
                  )}
                </div>
                <div
                  className="machine-lane"
                  onDragOver={(e) => handleDragOver(e, wc)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, wc, undefined)}
                  title={`Drop a job on line ${wc}`}
                  style={{ width: timelineWidth, minHeight: Math.max(22, ((subRowMap.maxRows[wc] || 0) + 1) * prefs.rowHeight + 2) }}
                >
                  {/* Calendar background */}
                  <div className="machine-calendar-bg">
                    <div className="gantt-virtual-spacer" style={{ width: firstVisDay * pxPerDay }} />
                    {Array.from({ length: lastVisDay - firstVisDay }).map((_, j) => {
                      const i = firstVisDay + j;
                      const day = addDays(timelineStart, i);
                      const weekday = day.getDay();
                      const workingDays = workcentreCalendars[wc]?.workingDays || [1, 2, 3, 4, 5];
                      const isWorkingDay = workingDays.includes(weekday);
                      const isWeekend = weekday === 0 || weekday === 6;
                      return (
                        <div
                          key={`${wc}-${i}`}
                          className={`calendar-cell ${isWorkingDay ? 'working' : 'off'}`}
                          style={{
                            width: pxPerDay,
                            background: prefs.highlightWeekends && isWeekend
                              ? '#fff3cd'
                              : getCalendarDayBackground(workcentreCalendars[wc], day)
                          }}
                        />
                      );
                    })}
                  </div>

                  {/* Today line */}
                  {prefs.showNowLine && nowPx !== null && (
                    <div className="now-line" style={{ left: nowPx }} />
                  )}

                  {/* Operation bars — multi-phase segments */}
                  {(opsByWorkcentre.get(wc) || [])
                    .filter((op) => {
                      // Skip bars far outside the scroll window (virtualisation).
                      const s0 = new Date((op as any).setupStart || op.plannedStartDate).getTime();
                      const e0 = new Date((op as any).moveEnd || op.plannedEndDate).getTime();
                      return e0 >= visStartMs && s0 <= visEndMs;
                    })
                    .map((op) => {
                      const opKey = `${op.jobId}::${op.opId}`;
                      const isLocked = !!lockedOps[opKey] || (externalLockedOps?.has(opKey) ?? false);
                      const isHighlit = highlightJobId === op.jobId;
                      const opColor = getOpColor(op);
                      const jobStatus = jobStatusById.get(op.jobId) ?? 'Scheduled';
                      const opStart = new Date(op.plannedStartDate);
                      const opEnd = new Date(op.plannedEndDate);
                      const jobMeta = jobsById.get(op.jobId);
                      const itemCode = jobMeta?.itemCode || '';
                      const itemDesc = String((jobMeta as any)?.StockDescription || (jobMeta as any)?.description || '');
                      const qty = jobMeta?.quantity ? `× ${jobMeta.quantity}` : '';

                      // Phase timestamps (with fallbacks for pre-upgrade data)
                      const setupStart = op.setupStart ? new Date(op.setupStart) : opStart;
                      const setupEnd = op.setupEnd ? new Date(op.setupEnd) : opStart;
                      const runStart = op.runStart ? new Date(op.runStart) : setupEnd;
                      const runEnd = op.runEnd ? new Date(op.runEnd) : opEnd;
                      // queueEnd kept for future tooltip work (queue lag display).
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      const queueEnd = op.queueEnd ? new Date(op.queueEnd) : setupStart;
                      const moveEnd = op.moveEnd ? new Date(op.moveEnd) : runEnd;

                      const displayStart = setupStart;
                      const displayEnd = runEnd;
                      const setupMin = (op.setupTime as number) || Math.round((setupEnd.getTime() - setupStart.getTime()) / 60000);
                      const runMin = (op.runTime as number) || Math.round((runEnd.getTime() - runStart.getTime()) / 60000);
                      const queueMin = (op.queueTime as number) || 0;
                      const moveMin = (op.moveTime as number) || Math.max(0, Math.round((moveEnd.getTime() - runEnd.getTime()) / 60000));
                      const durationH = Math.round(((setupMin + runMin) / 60) * 10) / 10;

                      const displaySegments = getProductiveDisplaySegments(displayStart, displayEnd, workcentreCalendars[wc]);
                      const rowIndex = subRowMap.map[opKey] || 0;
                      const depRole = depRoleByJobId.get(op.jobId) ?? null;

                      return (
                        <GanttOperationBar
                          key={opKey}
                          opKey={opKey}
                          jobId={op.jobId}
                          depRole={depRole}
                          masterJobId={parentMap.get(op.jobId)}
                          opId={op.opId}
                          sequence={(op as any).sequence || '?'}
                          workcentreId={op.workcentreId}
                          isLocked={isLocked}
                          isHighlit={isHighlit}
                          isViolated={violatedOpIds.has(op.opId)}
                          isFocused={focusedViolationOpId === op.opId}
                          isSelected={selectedOps.has(opKey)}
                          isDraggable
                          opColor={opColor}
                          jobStatus={jobStatus}
                          rowIndex={rowIndex}
                          prefs={prefs}
                          displayStart={displayStart}
                          displayEnd={displayEnd}
                          setupStart={setupStart}
                          setupEnd={setupEnd}
                          runStart={runStart}
                          runEnd={runEnd}
                          setupMin={setupMin}
                          runMin={runMin}
                          queueMin={queueMin}
                          moveMin={moveMin}
                          durationH={durationH}
                          itemCode={itemCode}
                          itemDesc={itemDesc}
                          qty={qty}
                          opStatus={op.opStatus}
                          displaySegments={displaySegments}
                          calculatePosition={calculatePosition}
                          calculateWidth={calculateWidth}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/op-key', opKey);
                            e.dataTransfer.effectAllowed = 'move';
                            draggedItemRef.current = { type: 'operation', jobId: op.jobId, opId: op.opId };
                            dragAnchorRef.current = {
                              opKey,
                              origStartMs: new Date(op.plannedStartDate).getTime(),
                              grabOffsetMs: (e.clientX - e.currentTarget.getBoundingClientRect().left) / (pxPerDay / (1000 * 60 * 60 * 24))
                            };
                            if (!selectedOps.has(opKey)) {
                              setSelectedOps(new Set([opKey]));
                            }
                          }}
                          onDragEnd={() => { draggedItemRef.current = null; }}
                          onClick={(e) => {
                            if (e.ctrlKey || e.metaKey) {
                              e.stopPropagation();
                              setSelectedOps(prev => {
                                const next = new Set(prev);
                                if (next.has(opKey)) next.delete(opKey); else next.add(opKey);
                                return next;
                              });
                            } else {
                              setSelectedOps(new Set([opKey]));
                              if (onHighlightJob) {
                                onHighlightJob(highlightJobId === op.jobId ? null : op.jobId);
                              }
                            }
                          }}
                          onContextMenu={(e) => openContextMenu(e, op.jobId, op.opId, isLocked)}
                          onMouseEnter={showTooltip}
                          onMouseLeave={hideTooltip}
                          onToggleLock={() => toggleLock(op.jobId, op.opId)}
                        />
                      );
                    })}

                  {/* Ghost bars — shown during drag to preview where all ops will land */}
                  {ghostBars
                    .filter(g => g.laneId === wc)
                    .map(g => (
                      <div
                        key={`ghost-${g.key}`}
                        className="machine-op-ghost"
                        style={{ left: `${g.left}px`, width: `${g.width}px` }}
                        title={g.label}
                      />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default React.memo(
  MachineGanttBoard,
  (prev, next) =>
    prev.schedule === next.schedule &&
    prev.resources === next.resources &&
    prev.horizonStart === next.horizonStart &&
    prev.horizonEnd === next.horizonEnd &&
    prev.loading === next.loading &&
    prev.constraintViolations === next.constraintViolations &&
    prev.focusWorkcentre === next.focusWorkcentre
);
