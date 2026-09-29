/**
 * slotFinder — manual-scheduling capacity math (extracted from App.tsx).
 * Identity adapters (no calendar) keep the tests focused on the interval logic.
 */

import {
  canFitInterval,
  findEarliestSlotOrForce,
  findEarliestSlotWithRetry,
  Interval,
  SlotCalendarAdapters,
} from './slotFinder';

const identity: SlotCalendarAdapters = {
  align: (ms) => ms,
  productiveEnd: (startMs, durationMs) => startMs + durationMs,
};

const HOUR = 60 * 60 * 1000;

describe('canFitInterval', () => {
  it('fits when there are no bookings', () => {
    expect(canFitInterval(0, HOUR, [], 1)).toBe(true);
  });

  it('rejects an overlap at capacity 1', () => {
    const intervals: Interval[] = [{ start: 0, end: HOUR }];
    expect(canFitInterval(HOUR / 2, HOUR * 1.5, intervals, 1)).toBe(false);
  });

  it('allows an overlap at capacity 2 but rejects a double overlap', () => {
    const intervals: Interval[] = [
      { start: 0, end: HOUR },
      { start: 0, end: HOUR },
    ];
    expect(canFitInterval(0, HOUR, intervals, 2)).toBe(false); // 2 concurrent = at capacity
    expect(canFitInterval(0, HOUR, [{ start: 0, end: HOUR }], 2)).toBe(true); // 1 concurrent < 2
  });

  it('back-to-back bookings do not conflict (half-open intervals)', () => {
    const intervals: Interval[] = [{ start: 0, end: HOUR }];
    expect(canFitInterval(HOUR, HOUR * 2, intervals, 1)).toBe(true);
  });
});

describe('findEarliestSlotOrForce', () => {
  it('places at the desired start when free', () => {
    const start = findEarliestSlotOrForce({
      desiredStartMs: 5 * HOUR,
      durationMs: HOUR,
      intervals: [],
      capacity: 1,
      workcentreId: 'WC-A',
      horizonStartMs: 0,
      adapters: identity,
    });
    expect(start).toBe(5 * HOUR);
  });

  it('slides past a blocking booking to its end', () => {
    const intervals: Interval[] = [{ start: 4 * HOUR, end: 7 * HOUR }];
    const start = findEarliestSlotOrForce({
      desiredStartMs: 5 * HOUR,
      durationMs: HOUR,
      intervals,
      capacity: 1,
      workcentreId: 'WC-A',
      horizonStartMs: 0,
      adapters: identity,
    });
    expect(start).toBe(7 * HOUR);
  });

  it('respects capacity > 1 (second machine takes the overlap)', () => {
    const intervals: Interval[] = [{ start: 5 * HOUR, end: 6 * HOUR }];
    const start = findEarliestSlotOrForce({
      desiredStartMs: 5 * HOUR,
      durationMs: HOUR,
      intervals,
      capacity: 2,
      workcentreId: 'WC-A',
      horizonStartMs: 0,
      adapters: identity,
    });
    expect(start).toBe(5 * HOUR);
  });

  it('clamps to the horizon start', () => {
    const start = findEarliestSlotOrForce({
      desiredStartMs: HOUR,
      durationMs: HOUR,
      intervals: [],
      capacity: 1,
      workcentreId: 'WC-A',
      horizonStartMs: 3 * HOUR,
      adapters: identity,
    });
    expect(start).toBe(3 * HOUR);
  });

  it('forces placement and notifies when nothing fits', () => {
    // Adapter that pushes every candidate before the horizon → nothing valid.
    const hostileAdapters: SlotCalendarAdapters = {
      align: () => -1, // always invalid (before horizonStartMs)
      productiveEnd: (s, d) => s + d,
    };
    const onForced = vi.fn();
    const start = findEarliestSlotOrForce({
      desiredStartMs: 5 * HOUR,
      durationMs: HOUR,
      intervals: [{ start: 0, end: 10 * HOUR }],
      capacity: 1,
      workcentreId: 'WC-A',
      horizonStartMs: 0,
      adapters: hostileAdapters,
      onForcedPlacement: onForced,
    });
    expect(onForced).toHaveBeenCalledWith('WC-A');
    expect(start).toBe(5 * HOUR);
  });
});

describe('findEarliestSlotWithRetry (job-drop variant)', () => {
  const base = {
    durationMs: HOUR,
    capacity: 1,
    workcentreId: 'WC-A',
    horizonStartMs: 0,
    horizonEndMs: 100 * HOUR,
    adapters: identity,
  };

  it('places at the desired start when free', () => {
    const start = findEarliestSlotWithRetry({ ...base, desiredStartMs: 5 * HOUR, intervals: [] });
    expect(start).toBe(5 * HOUR);
  });

  it('slides past consecutive bookings to the first gap', () => {
    const intervals: Interval[] = [
      { start: 5 * HOUR, end: 6 * HOUR },
      { start: 6 * HOUR, end: 8 * HOUR },
    ];
    const start = findEarliestSlotWithRetry({ ...base, desiredStartMs: 5 * HOUR, intervals });
    expect(start).toBe(8 * HOUR);
  });

  it('stops at horizonEnd and falls back to after the last booking', () => {
    // Every candidate aligns past the horizon end → loop breaks; the fallback
    // (after the last booking) is used instead.
    const lateAlign: SlotCalendarAdapters = {
      align: (ms) => (ms < 50 * HOUR ? 200 * HOUR : ms), // early candidates jump past horizon
      productiveEnd: (s, d) => s + d,
    };
    const intervals: Interval[] = [{ start: 0, end: 60 * HOUR }];
    const start = findEarliestSlotWithRetry({
      ...base,
      adapters: lateAlign,
      desiredStartMs: 2 * HOUR,
      intervals,
    });
    expect(start).toBe(60 * HOUR); // aligned fallback after last booking (≥ 50h passes through)
  });

  it('forces placement and notifies when even the fallback cannot fit', () => {
    const onForced = vi.fn();
    const hostile: SlotCalendarAdapters = {
      align: () => -1,
      productiveEnd: (s, d) => s + d,
    };
    const start = findEarliestSlotWithRetry({
      ...base,
      adapters: hostile,
      desiredStartMs: 5 * HOUR,
      intervals: [{ start: 0, end: 10 * HOUR }],
      onForcedPlacement: onForced,
    });
    expect(onForced).toHaveBeenCalledWith('WC-A');
    expect(start).toBe(5 * HOUR);
  });

  it('respects capacity > 1', () => {
    const intervals: Interval[] = [{ start: 5 * HOUR, end: 6 * HOUR }];
    const start = findEarliestSlotWithRetry({
      ...base,
      capacity: 2,
      desiredStartMs: 5 * HOUR,
      intervals,
    });
    expect(start).toBe(5 * HOUR);
  });
});
