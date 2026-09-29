/**
 * weekWindow — ISO-8601 week helpers for the week-based scheduling horizon.
 *
 * The Schedule ribbon and the Schedule Setup modal both let the user pick a
 * *week* to fill (Monday start) with an editable end date.  These helpers
 * convert between `<input type="week">` values (`YYYY-Www`) and plain
 * `YYYY-MM-DD` date strings, snapping to the Monday of the ISO week.
 *
 * All math runs in UTC so it is immune to the browser's local timezone and to
 * DST transitions; only whole calendar days are ever produced, so the returned
 * strings are safe to compare lexicographically.
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a Date's UTC calendar day as YYYY-MM-DD. */
function fmtUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Parse a YYYY-MM-DD string to a UTC Date at midnight. */
function parseUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

/** ISO week number + ISO week-numbering year for the week containing dateStr. */
export function isoWeekYear(dateStr: string): { week: number; year: number } {
  const d = parseUTC(dateStr);
  // Shift to the Thursday of this week — the Thursday decides the ISO year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { week, year };
}

/** `<input type="week">` value (YYYY-Www) for the week containing dateStr. */
export function toWeekValue(dateStr: string): string {
  if (!dateStr) return '';
  const { week, year } = isoWeekYear(dateStr);
  return `${year}-W${pad(week)}`;
}

/** Monday (YYYY-MM-DD) of the given ISO week value (YYYY-Www). */
export function mondayFromWeekValue(weekValue: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekValue);
  if (!m) return weekValue;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Monday of ISO week 1 is the Monday on or before Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + (week - 1) * 7);
  return fmtUTC(monday);
}

/** Add whole days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dateStr: string, days: number): string {
  const d = parseUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtUTC(d);
}

/** Monday (YYYY-MM-DD) of the week containing dateStr. */
export function mondayOf(dateStr: string): string {
  return mondayFromWeekValue(toWeekValue(dateStr));
}

/** Sunday (YYYY-MM-DD) of the week containing dateStr. */
export function sundayOf(dateStr: string): string {
  return addDays(mondayOf(dateStr), 6);
}
