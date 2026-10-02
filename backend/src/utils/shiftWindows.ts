/**
 * Productive windows of a machine calendar for one local day, in minutes from
 * that day's midnight. The ONE implementation shared by the scheduling
 * engine and CTP (CtpService must mirror the engine; sharing guarantees it).
 *
 *  - Weekly pattern: calendar.workingDays (default Mon–Fri) and the shifts'
 *    schedulable diversions (default 08:00–16:00).
 *  - Calendar exceptions (holidays, short days, extra working days) replace
 *    the pattern for their day.
 *  - Night shifts: when the pattern runs up to 24:00, the window that starts
 *    at 00:00 is the tail of the PREVIOUS day's shift. It works when the
 *    previous day works — so Friday's night shift keeps its Saturday-morning
 *    tail, and Monday 00:00–06:00 isn't worked for a Sunday shift that
 *    doesn't exist. (Simple shifts given as start/end with end < start are
 *    split the same way.)
 */
import { exceptionForDay, exceptionWindowMinutes, type CalendarLike } from './calendarExceptions';

export interface MinuteWindow { start: number; end: number; overtime?: boolean }

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

function hhmm(value: unknown, fallback: number): number {
  const v = String(value ?? '').trim();
  if (v === '24:00') return 1440;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return fallback;
  return Math.max(0, Math.min(1440, Number(m[1]) * 60 + Number(m[2])));
}

/** The calendar's daily pattern, before working-day rules. */
export function patternWindows(calendar: CalendarLike | null | undefined): MinuteWindow[] {
  const shifts = Array.isArray(calendar?.shifts) && calendar.shifts.length
    ? calendar.shifts
    : [{ startTime: '08:00', endTime: '16:00', diversions: [] }];
  const out: MinuteWindow[] = [];
  for (const shift of shifts) {
    const diversions = Array.isArray(shift?.diversions) ? shift.diversions : [];
    if (diversions.length) {
      for (const d of diversions) {
        if (!d?.schedulable) continue;
        const start = hhmm(d.startTime, NaN);
        const end = hhmm(d.endTime, NaN);
        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
        out.push({ start, end, overtime: /overtime/i.test(String(d.type || '')) });
      }
    } else {
      const start = hhmm(shift?.startTime, 8 * 60);
      const end = hhmm(shift?.endTime, 16 * 60);
      if (end > start) out.push({ start, end });
      else if (end < start) { out.push({ start, end: 1440 }); out.push({ start: 0, end }); } // overnight
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Day status: forced exception windows, or whether the weekly pattern applies. */
function dayStatus(calendar: CalendarLike | null | undefined, day: Date): { forced: MinuteWindow[] | null; working: boolean } {
  const exception = exceptionForDay(calendar, day);
  if (exception) {
    const forced = exceptionWindowMinutes(exception);
    if (forced) return { forced, working: forced.length > 0 };
    return { forced: null, working: true }; // extra working day: normal pattern
  }
  const workingDays = Array.isArray(calendar?.workingDays) && calendar.workingDays.length
    ? calendar.workingDays
    : DEFAULT_WORKING_DAYS;
  return { forced: null, working: workingDays.includes(day.getDay()) };
}

/** Productive windows for the local day containing `date`, in minutes from its midnight. */
export function dayWindowMinutes(calendar: CalendarLike | null | undefined, date: Date): MinuteWindow[] {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = dayStatus(calendar, day);
  if (today.forced) return today.forced.map((w) => ({ ...w }));

  const pattern = patternWindows(calendar);
  const wrapsMidnight = pattern.some((w) => w.end === 1440 && w.start > 0);
  const isTail = (w: MinuteWindow) => wrapsMidnight && w.start === 0 && w.end < 1440;

  let prevWorking: boolean | undefined;
  const previousDayWorks = () => {
    if (prevWorking === undefined) {
      const prev = new Date(day);
      prev.setDate(prev.getDate() - 1);
      const st = dayStatus(calendar, prev);
      // A forced exception replaces that day's shift, night shift included.
      prevWorking = !st.forced && st.working;
    }
    return prevWorking;
  };

  return pattern.filter((w) => (isTail(w) ? previousDayWorks() : today.working));
}
