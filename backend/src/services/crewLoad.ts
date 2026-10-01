/**
 * Crew (labour) load during a scheduling run: operators booked per pool over
 * time. Cumulative — a pool of 6 can run two 3-operator lines at once, not a
 * third. Used by SchedulingEngine's slot search.
 */
import { capacityAt, capacityBreakpoints, type CrewLookup } from '../utils/crews';

export interface CrewBooking { start: number; end: number; operators: number; jobId: string }

/** Highest operators in use at any instant inside [start, end). */
export function peakUsage(bookings: CrewBooking[], start: number, end: number): number {
  const events: Array<[number, number]> = [];
  for (const b of bookings) {
    const s = Math.max(start, b.start);
    const e = Math.min(end, b.end);
    if (e > s) { events.push([s, b.operators]); events.push([e, -b.operators]); }
  }
  // Ends before starts at the same instant: back-to-back bookings don't overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let peak = 0;
  for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}

export class CrewLoad {
  private bookings = new Map<string, CrewBooking[]>();

  constructor(private lookup: CrewLookup) {}

  /** Pool, operators needed and headcount for a line, or undefined if the line isn't crew-constrained. */
  needFor(workcentreId: string): { poolId: string; poolName: string; operators: number; headcount: number } | undefined {
    const line = this.lookup.lineNeeds.get(workcentreId);
    if (!line) return undefined;
    return {
      poolId: line.poolId,
      poolName: this.lookup.poolName.get(line.poolId) ?? line.poolId,
      operators: line.operators,
      headcount: this.lookup.headcount.get(line.poolId) ?? 0,
    };
  }

  /**
   * null when the line's crew can staff [start, end); otherwise the earliest
   * time worth trying again (the first end of an overlapping booking).
   */
  nextFreeAt(workcentreId: string, start: Date, end: Date): Date | null {
    const need = this.needFor(workcentreId);
    if (!need) return null;
    const s = start.getTime(); const e = end.getTime();
    const list = this.bookings.get(need.poolId) || [];
    const overlapping = list.filter((b) => b.start < e && b.end > s);
    const cap = this.lookup.capacity?.get(need.poolId);
    if (cap) {
      // Capacity changes with shifts: check every segment between booking
      // and shift edges. On the first segment that can't be staffed, no start
      // before its end can work (the op would still cover it) — retry there.
      const points = new Set<number>([s, e, ...capacityBreakpoints(cap, s, e)]);
      for (const b of overlapping) { if (b.start > s && b.start < e) points.add(b.start); if (b.end > s && b.end < e) points.add(b.end); }
      const sorted = [...points].sort((x, y) => x - y);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        let used = 0;
        for (const b of overlapping) if (b.start <= a && b.end > a) used += b.operators;
        if (used + need.operators > capacityAt(cap, new Date(a))) return new Date(sorted[i + 1]);
      }
      return null;
    }
    if (peakUsage(overlapping, s, e) + need.operators <= need.headcount) return null;
    let next = Infinity;
    for (const b of overlapping) if (b.end < next) next = b.end;
    return Number.isFinite(next) ? new Date(next) : null;
  }

  book(workcentreId: string, start: Date, end: Date, jobId: string): void {
    const need = this.needFor(workcentreId);
    if (!need) return;
    const list = this.bookings.get(need.poolId) || [];
    list.push({ start: start.getTime(), end: end.getTime(), operators: need.operators, jobId });
    this.bookings.set(need.poolId, list);
  }

  /** Bookings in the line's pool overlapping [start, end) — for "waited for crew" explanations. */
  overlapping(workcentreId: string, start: Date, end: Date): CrewBooking[] {
    const need = this.needFor(workcentreId);
    if (!need) return [];
    const s = start.getTime(); const e = end.getTime();
    return (this.bookings.get(need.poolId) || []).filter((b) => b.start < e && b.end > s);
  }
}
