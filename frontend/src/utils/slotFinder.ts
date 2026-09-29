/**
 * Manual-scheduling slot finder (extracted from App.tsx — PLAN_2026-07-07 §4.3).
 *
 * Pure capacity math; calendar awareness is injected via adapters so the
 * logic is unit-testable without the App's shift-window helpers.
 */

export interface Interval {
  start: number;
  end: number;
}

export interface SlotCalendarAdapters {
  /** Snap a start time into the next productive shift window. */
  align: (ms: number, durationMs: number, workcentreId: string) => number;
  /** Walk shift windows to get the productive end for a booked duration. */
  productiveEnd: (startMs: number, durationMs: number, workcentreId: string) => number;
}

/**
 * True when [startMs, endMs) can be booked without exceeding `capacity`
 * concurrent bookings among `intervals`. Sweep-line over overlap events.
 */
export function canFitInterval(
  startMs: number,
  endMs: number,
  intervals: Interval[],
  capacity: number
): boolean {
  const events: Array<{ t: number; d: number }> = [];

  for (const interval of intervals) {
    if (interval.start < endMs && interval.end > startMs) {
      events.push({ t: Math.max(interval.start, startMs), d: 1 });
      events.push({ t: Math.min(interval.end, endMs), d: -1 });
    }
  }

  events.sort((a, b) => (a.t - b.t) || (a.d - b.d));

  let concurrent = 0;
  for (const evt of events) {
    concurrent += evt.d;
    if (concurrent >= capacity) {
      return false;
    }
  }
  return true;
}

export interface FindSlotWithRetryOptions extends FindSlotOptions {
  /** Stop searching once an aligned candidate passes this instant. */
  horizonEndMs: number;
}

/**
 * Job-drop slot finder: like findEarliestSlotOrForce, but bounded by
 * horizonEndMs and implemented as a work queue so candidates discovered
 * mid-search (e.g. when calendar alignment jumps into a blocking interval)
 * are genuinely retried. Note: because every interval end ≥ the desired
 * start is pre-seeded, the queue usually contains everything up front —
 * this matches the original App.tsx behaviour exactly.
 */
export function findEarliestSlotWithRetry(opts: FindSlotWithRetryOptions): number {
  const {
    desiredStartMs, durationMs, intervals, capacity, workcentreId,
    horizonStartMs, horizonEndMs, adapters, onForcedPlacement,
  } = opts;

  const seen = new Set<number>();
  const queue: number[] = [];
  const push = (ms: number) => {
    if (!seen.has(ms)) {
      seen.add(ms);
      queue.push(ms);
    }
  };

  push(Math.max(desiredStartMs, horizonStartMs));
  for (const interval of intervals) {
    if (interval.end >= desiredStartMs) push(interval.end);
  }

  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    queue.sort((a, b) => a - b);
    const candidate = queue.shift() as number;

    const alignedCandidate = adapters.align(candidate, durationMs, workcentreId);
    if (alignedCandidate > horizonEndMs) break; // well past the drop window — stop

    const candidateEndMs = adapters.productiveEnd(alignedCandidate, durationMs, workcentreId);
    if (canFitInterval(alignedCandidate, candidateEndMs, intervals, capacity)) {
      return alignedCandidate;
    }

    // Alignment may have jumped into a new blocking interval — queue its end.
    for (const interval of intervals) {
      if (interval.end > alignedCandidate && interval.end > candidate) push(interval.end);
    }
  }

  // All candidates failed — fall back to just after the last booking.
  const lastEnd = intervals.length > 0 ? Math.max(...intervals.map((i) => i.end)) : desiredStartMs;
  const fallback = Math.max(desiredStartMs, lastEnd, horizonStartMs);
  const fallbackStart = adapters.align(fallback, durationMs, workcentreId);
  const fallbackEnd = adapters.productiveEnd(fallbackStart, durationMs, workcentreId);
  if (fallbackStart >= horizonStartMs && canFitInterval(fallbackStart, fallbackEnd, intervals, capacity)) {
    return fallbackStart;
  }

  // Absolute last resort — place at the desired start unchecked.
  onForcedPlacement?.(workcentreId);
  return Math.max(desiredStartMs, horizonStartMs);
}

export interface FindSlotOptions {
  desiredStartMs: number;
  durationMs: number;
  intervals: Interval[];
  capacity: number;
  workcentreId: string;
  horizonStartMs: number;
  adapters: SlotCalendarAdapters;
  /**
   * Called when no calendar-respecting slot could be found and the op is
   * placed at the desired start unchecked (possibly outside shift hours).
   */
  onForcedPlacement?: (workcentreId: string) => void;
}

/**
 * Board-move slot finder: tries the desired start and the end of every
 * potentially-blocking interval (calendar-aligned), then a fallback after
 * all existing bookings, and finally forces the desired start.
 * Always returns a placement (never null) — the forced path notifies via
 * onForcedPlacement.
 */
export function findEarliestSlotOrForce(opts: FindSlotOptions): number {
  const {
    desiredStartMs, durationMs, intervals, capacity, workcentreId,
    horizonStartMs, adapters, onForcedPlacement,
  } = opts;

  const candidateSet = new Set<number>([Math.max(desiredStartMs, horizonStartMs)]);
  for (const interval of intervals) {
    if (interval.end >= desiredStartMs) candidateSet.add(interval.end);
  }
  const candidates = Array.from(candidateSet).sort((a, b) => a - b);

  for (const candidate of candidates) {
    const alignedCandidate = adapters.align(candidate, durationMs, workcentreId);
    const candidateEndMs = adapters.productiveEnd(alignedCandidate, durationMs, workcentreId);
    if (
      alignedCandidate >= horizonStartMs &&
      canFitInterval(alignedCandidate, candidateEndMs, intervals, capacity)
    ) {
      return alignedCandidate;
    }
  }

  const fallbackStart = adapters.align(
    Math.max(desiredStartMs, ...intervals.map((i) => i.end), horizonStartMs),
    durationMs,
    workcentreId
  );
  const fallbackEnd = adapters.productiveEnd(fallbackStart, durationMs, workcentreId);
  if (fallbackStart >= horizonStartMs && canFitInterval(fallbackStart, fallbackEnd, intervals, capacity)) {
    return fallbackStart;
  }

  // Absolute last resort — place at desired start unchecked. This is the
  // ONLY path that can land an op outside shift hours.
  onForcedPlacement?.(workcentreId);
  return Math.max(desiredStartMs, horizonStartMs);
}
