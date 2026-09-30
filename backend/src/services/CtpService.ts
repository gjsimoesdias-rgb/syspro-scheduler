/**
 * CtpService — Capable-to-Promise (CTP) simulation.
 *
 * Answers the classic APS question: "If I accept this order today, what
 * delivery date can I promise?" — without disturbing the live schedule.
 *
 * The simulation places a prospective routing (sequence of operations)
 * against the CURRENT committed load: busy intervals extracted from the
 * latest saved schedule, per resource. Each operation is placed at the
 * earliest instant that
 *   1. is after the previous operation finishes (strict precedence),
 *   2. fits inside the resource's productive windows, and
 *   3. does not overlap any already-committed operation on that resource.
 *
 * MASTER / SUB-JOB FAMILIES (SYSPRO WipMasterSub semantics):
 * a request may carry `subRoutings` in addition to the master `operations`.
 * Sub-job legs are simulated first — they may run in PARALLEL with each
 * other but compete for the same capacity (slots reserved by one leg are
 * busy for the next). The master routing starts no earlier than the LAST
 * sub-job finish; the promise date is the master's completion.
 *
 * Productive windows MUST match SchedulingEngine.getProductiveWindowsForDay
 * exactly, otherwise promise dates disagree with where the engine would
 * actually place the work:
 *   - workingDays default to Mon–Fri;
 *   - shifts default to 08:00–16:00 when the calendar has none;
 *   - when a shift carries diversions, ONLY schedulable diversions count
 *     (a 00:00–23:59 shift with a Production 08:00–16:00 diversion is an
 *     8-hour day, not a 24-hour one).
 *
 * Among all resources of the operation's workcentre, the one yielding the
 * earliest finish wins. The result is a promise date plus a per-operation
 * placement breakdown the planner can inspect.
 */

import { exceptionForDay, exceptionWindowMinutes } from '../utils/calendarExceptions';

export interface CtpOperationInput {
  workcentreId: string;
  setupMinutes: number;
  runMinutes: number;
  description?: string;
}

export interface CtpSubRouting {
  /** Display label, e.g. the sub-job id. */
  label?: string;
  operations: CtpOperationInput[];
}

interface ShiftDiversion {
  type?: string;
  startTime?: string;
  endTime?: string;
  schedulable?: boolean;
}

export interface CtpResourceInfo {
  resourceId: string;
  worcentreId: string;
  name?: string;
  calendar?: {
    workingDays?: number[];
    holidays?: Array<{ date: unknown; isWorking?: boolean; startTime?: string; endTime?: string }>;
    shifts?: Array<{ startTime?: string; endTime?: string; diversions?: ShiftDiversion[] }>;
  };
}

export interface BusyInterval {
  start: number; // epoch ms
  end: number;   // epoch ms
}

export interface CtpPlacement {
  sequence: number;
  workcentreId: string;
  resourceId: string;
  resourceName?: string;
  description?: string;
  /** Which family leg this placement belongs to ('Master', or the sub label). */
  leg?: string;
  start: string; // ISO
  end: string;   // ISO
  setupMinutes: number;
  runMinutes: number;
  waitMinutes: number; // idle time between previous op end (same leg) and this op start
}

export interface CtpResult {
  feasible: boolean;
  promiseDate: string | null;
  placements: CtpPlacement[];
  message?: string;
  /** Notes about simplifications applied (e.g. op longer than a shift). */
  assumptions: string[];
  /** Present when subRoutings were supplied: when the master may start. */
  masterStart?: string;
  /** Per-leg completion times (sub legs only). */
  legEnds?: Array<{ leg: string; end: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_DAYS = 366;
/** How far ahead to probe for the longest productive window of a resource. */
const WINDOW_PROBE_DAYS = 14;

/** Parse "HH:MM" to minutes since midnight; NaN when malformed. "24:00" → 1440. */
function hhmmToMinutes(v: string | undefined): number {
  const trimmed = String(v || '').trim();
  if (trimmed === '24:00') return 1440;
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return Number.NaN;
  return Math.max(0, Math.min(1440, Number(m[1]) * 60 + Number(m[2])));
}

/**
 * Productive windows for the day containing `dayStart` (local midnight epoch
 * ms). Mirrors SchedulingEngine.getProductiveWindowsForDay: Mon–Fri default,
 * 08:00–16:00 default shift, schedulable diversions override shift bounds.
 * Returns [] on non-working days.
 */
export function windowsForDay(res: CtpResourceInfo, dayStart: number): BusyInterval[] {
  const cal = res.calendar;
  const weekday = new Date(dayStart).getDay();
  const workingDays = Array.isArray(cal?.workingDays) && cal!.workingDays!.length > 0
    ? cal!.workingDays!
    : [1, 2, 3, 4, 5];
  const exception = exceptionForDay(cal, new Date(dayStart));
  if (exception) {
    const forced = exceptionWindowMinutes(exception);
    if (forced) return forced.map(({ start, end }) => ({ start: dayStart + start * 60000, end: dayStart + end * 60000 }));
  } else if (!workingDays.includes(weekday)) return [];

  const shifts = Array.isArray(cal?.shifts) && cal!.shifts!.length > 0
    ? cal!.shifts!
    : [{ startTime: '08:00', endTime: '16:00', diversions: [] as ShiftDiversion[] }];

  const windows: BusyInterval[] = [];
  for (const shift of shifts) {
    const diversions = Array.isArray(shift.diversions) ? shift.diversions : [];
    if (diversions.length) {
      // Only schedulable (Production/Overtime) diversions are workable time.
      for (const d of diversions) {
        if (!d?.schedulable) continue;
        const startMin = hhmmToMinutes(d.startTime);
        const endMin = hhmmToMinutes(d.endTime);
        if (Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin) continue;
        windows.push({ start: dayStart + startMin * 60000, end: dayStart + endMin * 60000 });
      }
    } else {
      const startMin = hhmmToMinutes(shift.startTime || '08:00');
      const endMin = hhmmToMinutes(shift.endTime || '16:00');
      if (!Number.isNaN(startMin) && !Number.isNaN(endMin) && endMin > startMin) {
        windows.push({ start: dayStart + startMin * 60000, end: dayStart + endMin * 60000 });
      }
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

/** Local midnight for the day containing t. */
function midnightOf(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Longest single productive window over the next WINDOW_PROBE_DAYS days. */
function longestWindowMs(res: CtpResourceInfo, from: number): number {
  let max = 0;
  let day = midnightOf(from);
  for (let i = 0; i < WINDOW_PROBE_DAYS; i++, day += DAY_MS) {
    for (const w of windowsForDay(res, day)) {
      if (w.end - w.start > max) max = w.end - w.start;
    }
  }
  return max;
}

/**
 * Earliest start >= notBefore where [start, start + durMs] fits in one
 * productive window of `res` and overlaps none of `busy` (sorted by start).
 * Returns null when nothing fits within MAX_SEARCH_DAYS.
 */
export function findEarliestSlot(
  res: CtpResourceInfo,
  busy: BusyInterval[],
  notBefore: number,
  durMs: number,
  assumptions: Set<string>
): BusyInterval | null {
  // Operations longer than every productive window can never fit inside one
  // shift. Place them across shift boundaries instead (calendar relaxed) and
  // say so — the alternative would be a misleading hard "infeasible".
  const maxWindowMs = longestWindowMs(res, notBefore);
  const ignoreCalendar = maxWindowMs === 0 || durMs > maxWindowMs;
  if (ignoreCalendar) {
    assumptions.add(
      maxWindowMs === 0
        ? `Resource ${res.resourceId} has no productive windows in the next ${WINDOW_PROBE_DAYS} days — placed without calendar constraints.`
        : `Operation (${Math.round(durMs / 60000)} min) is longer than the longest shift window on ${res.resourceId} — placed across shift boundaries (calendar relaxed).`
    );
  }

  const horizon = notBefore + MAX_SEARCH_DAYS * DAY_MS;
  let t = notBefore;

  while (t < horizon) {
    // 1. Clamp into a productive window.
    if (!ignoreCalendar) {
      let day = midnightOf(t);
      let placed = false;
      for (let i = 0; i < MAX_SEARCH_DAYS && !placed; i++, day += DAY_MS) {
        for (const w of windowsForDay(res, day)) {
          const candidate = Math.max(t, w.start);
          if (candidate + durMs <= w.end) {
            t = candidate;
            placed = true;
            break;
          }
        }
      }
      if (!placed) return null;
    }

    // 2. Push past any overlapping committed operation.
    const conflict = busy.find((b) => b.start < t + durMs && b.end > t);
    if (!conflict) {
      return { start: t, end: t + durMs };
    }
    t = conflict.end;
    // Loop re-clamps t into the next productive window if needed.
  }
  return null;
}

/**
 * Place one routing (sequence of ops) starting no earlier than `notBefore`.
 * Reserves every placed slot in `sortedBusy` so subsequent legs see the load.
 * Returns the placements and the routing end, or an error message.
 */
function placeRouting(
  operations: CtpOperationInput[],
  leg: string | undefined,
  notBefore: number,
  resources: CtpResourceInfo[],
  sortedBusy: Map<string, BusyInterval[]>,
  assumptions: Set<string>
): { placements: CtpPlacement[]; end: number } | { error: string } {
  const placements: CtpPlacement[] = [];
  let prevEnd = notBefore;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const candidates = resources.filter((r) => r.worcentreId === op.workcentreId);
    if (candidates.length === 0) {
      return { error: `No resource found for workcentre ${op.workcentreId} (${leg ? `${leg}, ` : ''}operation ${i + 1}).` };
    }

    const durMs = Math.max(1, Math.round((op.setupMinutes + op.runMinutes) * 60000));
    let best: { slot: BusyInterval; res: CtpResourceInfo } | null = null;

    for (const res of candidates) {
      const slot = findEarliestSlot(res, sortedBusy.get(res.resourceId) || [], prevEnd, durMs, assumptions);
      if (slot && (!best || slot.end < best.slot.end)) {
        best = { slot, res };
      }
    }

    if (!best) {
      return { error: `No capacity found for ${leg ? `${leg}, ` : ''}operation ${i + 1} on workcentre ${op.workcentreId} within ${MAX_SEARCH_DAYS} days.` };
    }

    placements.push({
      sequence: i + 1,
      workcentreId: op.workcentreId,
      resourceId: best.res.resourceId,
      resourceName: best.res.name,
      description: op.description,
      leg,
      start: new Date(best.slot.start).toISOString(),
      end: new Date(best.slot.end).toISOString(),
      setupMinutes: op.setupMinutes,
      runMinutes: op.runMinutes,
      waitMinutes: Math.max(0, Math.round((best.slot.start - prevEnd) / 60000)),
    });

    // Reserve the slot so later ops (this leg AND other legs) can't double-book.
    const list = sortedBusy.get(best.res.resourceId) || [];
    list.push(best.slot);
    list.sort((a, b) => a.start - b.start);
    sortedBusy.set(best.res.resourceId, list);

    prevEnd = best.slot.end;
  }

  return { placements, end: prevEnd };
}

export function computeCtp(params: {
  /** The (master) routing. With subRoutings present, it starts after the last sub finishes. */
  operations: CtpOperationInput[];
  /** Optional SYSPRO-style sub-job routings; run in parallel before the master. */
  subRoutings?: CtpSubRouting[];
  resources: CtpResourceInfo[];
  busyByResource: Map<string, BusyInterval[]>;
  earliestStart: Date;
  desiredDueDate?: Date;
}): CtpResult & { onTime?: boolean } {
  const { operations, subRoutings, resources, busyByResource, earliestStart, desiredDueDate } = params;
  const assumptions = new Set<string>();
  const placements: CtpPlacement[] = [];

  // Pre-sort busy intervals once per resource.
  const sortedBusy = new Map<string, BusyInterval[]>();
  for (const [rid, list] of busyByResource) {
    sortedBusy.set(rid, [...list].sort((a, b) => a.start - b.start));
  }
  if (sortedBusy.size === 0) {
    assumptions.add('No saved schedule found — promise computed against an empty shop load.');
  }

  const hasFamily = Array.isArray(subRoutings) && subRoutings.length > 0;
  const legEnds: Array<{ leg: string; end: string }> = [];
  let masterEarliest = earliestStart.getTime();

  // 1. Sub-job legs — parallel start, shared capacity (SYSPRO: subs feed the master).
  if (hasFamily) {
    for (let s = 0; s < subRoutings!.length; s++) {
      const sub = subRoutings![s];
      const legName = sub.label?.trim() || `Sub ${s + 1}`;
      if (!sub.operations?.length) continue;
      const placed = placeRouting(sub.operations, legName, earliestStart.getTime(), resources, sortedBusy, assumptions);
      if ('error' in placed) {
        return {
          feasible: false,
          promiseDate: null,
          placements,
          assumptions: Array.from(assumptions),
          message: placed.error,
        };
      }
      placements.push(...placed.placements);
      legEnds.push({ leg: legName, end: new Date(placed.end).toISOString() });
      if (placed.end > masterEarliest) masterEarliest = placed.end;
    }
    assumptions.add('Sub-jobs start in parallel and share capacity; the master routing starts after the last sub-job finishes (SYSPRO master/sub precedence).');
  }

  // 2. Master routing (or the only routing when no family is involved).
  const masterPlaced = placeRouting(
    operations,
    hasFamily ? 'Master' : undefined,
    masterEarliest,
    resources,
    sortedBusy,
    assumptions
  );
  if ('error' in masterPlaced) {
    return {
      feasible: false,
      promiseDate: null,
      placements,
      assumptions: Array.from(assumptions),
      message: masterPlaced.error,
      ...(hasFamily ? { masterStart: new Date(masterEarliest).toISOString(), legEnds } : {}),
    };
  }
  placements.push(...masterPlaced.placements);

  const promise = new Date(masterPlaced.end);
  return {
    feasible: true,
    promiseDate: promise.toISOString(),
    placements,
    assumptions: Array.from(assumptions),
    onTime: desiredDueDate ? promise.getTime() <= desiredDueDate.getTime() : undefined,
    ...(hasFamily ? { masterStart: new Date(masterEarliest).toISOString(), legEnds } : {}),
  };
}
