/**
 * Productive-window (shift calendar) math for manual scheduling —
 * extracted from App.tsx (PLAN §4.3 slice 3). Pure logic; the caller
 * supplies the calendar lookup and horizon bounds via CalendarWindowEnv.
 */

export interface ProductiveWindow {
  startMs: number;
  endMs: number;
}

/** The calendar fields the window logic reads (all optional; defaults apply). */
export interface CalendarLike {
  workingDays?: number[];
  shifts?: Array<{
    startTime?: string;
    endTime?: string;
    diversions?: Array<{ startTime?: string; endTime?: string; schedulable?: boolean }>;
  }>;
}

export interface CalendarWindowEnv {
  /** Resolve the shift calendar for a workcentre (or machine) id. */
  getCalendar: (workcentreId: string) => CalendarLike | null | undefined;
  horizonStartMs: number;
  horizonEndMs: number;
}

/** "HH:mm" → minutes since midnight; "24:00" → 1440; clamped to [0, 1440]. */
export const timeToMinutes = (value?: string): number => {
  if (value === '24:00') return 1440;
  const [hours, minutes] = String(value || '00:00').split(':').map((part) => Number(part) || 0);
  return Math.max(0, Math.min(1440, hours * 60 + minutes));
};

/**
 * The schedulable windows of one date for a calendar: shift spans, or the
 * schedulable diversions inside each shift when diversions are defined.
 * Non-working days return []. Missing calendar data falls back to
 * Mon–Fri 08:00–16:00.
 */
export function getProductiveWindowsForDate(calendar: CalendarLike | null | undefined, baseDate: Date): ProductiveWindow[] {
  const day = new Date(baseDate);
  day.setHours(0, 0, 0, 0);

  const workingDays = Array.isArray(calendar?.workingDays) && calendar.workingDays.length
    ? calendar.workingDays
    : [1, 2, 3, 4, 5];

  if (!workingDays.includes(day.getDay())) {
    return [];
  }

  const shifts = Array.isArray(calendar?.shifts) && calendar.shifts.length
    ? calendar.shifts
    : [{ startTime: '08:00', endTime: '16:00', diversions: [] }];

  const windows: ProductiveWindow[] = [];

  for (const shift of shifts) {
    const diversions = Array.isArray(shift?.diversions) ? shift.diversions : [];
    if (diversions.length) {
      for (const diversion of diversions) {
        if (!diversion?.schedulable) continue;
        const start = new Date(day);
        start.setMinutes(timeToMinutes(diversion.startTime), 0, 0);
        const end = new Date(day);
        end.setMinutes(timeToMinutes(diversion.endTime), 0, 0);
        if (end.getTime() > start.getTime()) {
          windows.push({ startMs: start.getTime(), endMs: end.getTime() });
        }
      }
    } else {
      const start = new Date(day);
      start.setMinutes(timeToMinutes(shift?.startTime || '08:00'), 0, 0);
      const end = new Date(day);
      end.setMinutes(timeToMinutes(shift?.endTime || '16:00'), 0, 0);
      if (end.getTime() > start.getTime()) {
        windows.push({ startMs: start.getTime(), endMs: end.getTime() });
      }
    }
  }

  return windows.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Snap a candidate start into the next productive window at or after it
 * (searching up to 60 days). Candidates past the horizon, or workcentres
 * without a calendar, pass through unchanged.
 */
export function alignToProductiveWindow(
  env: CalendarWindowEnv,
  candidateMs: number,
  workcentreId: string
): number {
  const normalizedCandidateMs = Math.max(candidateMs, env.horizonStartMs);
  if (normalizedCandidateMs > env.horizonEndMs) return normalizedCandidateMs;

  const calendar = env.getCalendar(workcentreId);
  if (!calendar) return normalizedCandidateMs;

  const probe = new Date(normalizedCandidateMs);
  for (let i = 0; i < 60; i++) {
    if (probe.getTime() > env.horizonEndMs) break;

    const windows = getProductiveWindowsForDate(calendar, probe);
    for (const window of windows) {
      const aligned = Math.max(normalizedCandidateMs, probe.getTime(), window.startMs);
      if (aligned < window.endMs) {
        return aligned;
      }
    }
    probe.setDate(probe.getDate() + 1);
    probe.setHours(0, 0, 0, 0);
  }

  return normalizedCandidateMs;
}

/**
 * Walk productive windows from startMs until bookedMs of working time is
 * consumed and return the end instant. Past-horizon starts and missing
 * calendars fall back to raw wall-clock time.
 */
export function calculateProductiveEndMs(
  env: CalendarWindowEnv,
  startMs: number,
  bookedMs: number,
  workcentreId: string
): number {
  if (bookedMs <= 0) return startMs;
  if (startMs > env.horizonEndMs) return startMs + bookedMs;

  const calendar = env.getCalendar(workcentreId);
  if (!calendar) return startMs + bookedMs;

  let remainingMs = bookedMs;
  let cursorMs = startMs;

  for (let i = 0; i < 120 && remainingMs > 0; i++) {
    if (cursorMs > env.horizonEndMs) break;

    const alignedStart = alignToProductiveWindow(env, cursorMs, workcentreId);
    const windows = getProductiveWindowsForDate(calendar, new Date(alignedStart));
    const window = windows.find((item) => alignedStart >= item.startMs && alignedStart < item.endMs)
      || windows.find((item) => item.endMs > alignedStart);

    if (!window) {
      const nextDay = new Date(alignedStart);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);
      cursorMs = nextDay.getTime();
      continue;
    }

    const segmentStart = Math.max(alignedStart, window.startMs);
    const availableMs = Math.max(0, window.endMs - segmentStart);
    if (availableMs >= remainingMs) {
      return segmentStart + remainingMs;
    }

    remainingMs -= availableMs;
    cursorMs = window.endMs + 60 * 1000;
  }

  // Loop exhausted (horizon reached or no windows) — raw fallback.
  return startMs + bookedMs;
}
