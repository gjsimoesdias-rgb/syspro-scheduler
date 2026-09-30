/**
 * Calendar exceptions — public holidays, shutdowns, short days and extra
 * working days, set by the planner (Resources > Shifts > Calendar exceptions).
 *
 * Stored as app state ('calendarExceptions'); merged into each resource's
 * calendar.holidays before scheduling. Every engine (heuristic, CTP, CP-SAT)
 * reads a day through exceptionForDay / exceptionWindowMinutes so they agree.
 *
 * Semantics for one day:
 *   isWorking=false, no times  → closed all day
 *   startTime+endTime set      → only that window is workable (short day, or
 *                                overtime on a normally closed day)
 *   isWorking=true, no times   → normal shift pattern, even on a weekend
 * A work-centre exception beats a plant-wide one on the same day.
 */

export interface CalendarException {
  id: string;
  date: string;          // YYYY-MM-DD, local plant day
  name: string;
  scope: string;         // 'plant' or a work-centre id
  isWorking: boolean;
  startTime?: string;    // HH:MM
  endTime?: string;      // HH:MM (24:00 allowed)
}

/** Local calendar day key (YYYY-MM-DD). */
export const localDayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** Day key of a holiday whose date may be a Date, an ISO string or YYYY-MM-DD. */
export const holidayKey = (date: unknown): string => {
  if (typeof date === 'string' && DATE_ONLY.test(date)) return date;
  const d = date instanceof Date ? date : new Date(String(date));
  return Number.isNaN(d.getTime()) ? '' : localDayKey(d);
};

const toMinutes = (v: string): number => {
  if (v === '24:00') return 1440;
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};

/** The exception that applies to `date` (last match wins), or undefined. */
export function exceptionForDay(calendar: any, date: Date | string): any | undefined {
  const list = Array.isArray(calendar?.holidays) ? calendar.holidays : [];
  if (!list.length) return undefined;
  const key = typeof date === 'string' ? date : localDayKey(date);
  let found: any;
  for (const h of list) if (holidayKey(h?.date) === key) found = h;
  return found;
}

/**
 * Workable minutes-from-midnight windows forced by an exception, or null when
 * the exception keeps the normal shift pattern (isWorking with no times).
 */
export function exceptionWindowMinutes(h: any): Array<{ start: number; end: number }> | null {
  if (h?.startTime && h?.endTime && HHMM.test(h.startTime) && HHMM.test(h.endTime)) {
    const start = toMinutes(h.startTime);
    const end = toMinutes(h.endTime);
    return end > start ? [{ start, end }] : [];
  }
  return h?.isWorking ? null : [];
}

/** Validate/normalise one exception from the API. Returns an error string or the clean value. */
export function normaliseException(input: any): CalendarException | string {
  const date = String(input?.date || '').slice(0, 10);
  if (!DATE_ONLY.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) return 'date must be YYYY-MM-DD';
  const name = String(input?.name || '').trim();
  if (!name) return 'name is required';
  const scope = String(input?.scope || 'plant').trim() || 'plant';
  const startTime = input?.startTime ? String(input.startTime) : undefined;
  const endTime = input?.endTime ? String(input.endTime) : undefined;
  if (!!startTime !== !!endTime) return 'set both startTime and endTime, or neither';
  if (startTime && endTime) {
    if (!HHMM.test(startTime) || !HHMM.test(endTime)) return 'times must be HH:MM';
    if (toMinutes(endTime) <= toMinutes(startTime)) return 'endTime must be after startTime';
  }
  return {
    id: String(input?.id || `exc-${date}-${Math.random().toString(36).slice(2, 8)}`),
    date,
    name: name.slice(0, 100),
    scope,
    isWorking: startTime ? true : Boolean(input?.isWorking),
    ...(startTime ? { startTime, endTime } : {}),
  };
}

/**
 * Merge the exceptions that apply to each resource into calendar.holidays.
 * Plant-wide first, work-centre second, so the work-centre one wins.
 */
export function applyCalendarExceptions<T extends { worcentreId?: string; calendar?: any }>(
  resources: T[],
  exceptions: CalendarException[] | undefined,
): T[] {
  if (!Array.isArray(exceptions) || !exceptions.length) return resources;
  const toHoliday = (e: CalendarException) => ({
    holidayId: e.id, date: e.date, name: e.name, isWorking: e.isWorking,
    ...(e.startTime ? { startTime: e.startTime, endTime: e.endTime } : {}),
  });
  const plant = exceptions.filter((e) => !e.scope || e.scope === 'plant').map(toHoliday);
  return resources.map((r) => {
    const wc = exceptions.filter((e) => e.scope && e.scope !== 'plant' && e.scope === r.worcentreId).map(toHoliday);
    if (!plant.length && !wc.length) return r;
    const existing = Array.isArray(r.calendar?.holidays) ? r.calendar.holidays : [];
    return { ...r, calendar: { ...(r.calendar || {}), holidays: [...existing, ...plant, ...wc] } };
  });
}
