/**
 * calendarWindows — productive-window math (extracted from App.tsx).
 */

import {
  timeToMinutes,
  getProductiveWindowsForDate,
  alignToProductiveWindow,
  calculateProductiveEndMs,
  CalendarWindowEnv,
} from './calendarWindows';

const CAL = {
  workingDays: [1, 2, 3, 4, 5],
  shifts: [{ startTime: '08:00', endTime: '16:00', diversions: [] }],
};

// Mon 2026-06-01 (local time)
const MON = new Date(2026, 5, 1);
const SAT = new Date(2026, 5, 6);

const atTime = (base: Date, h: number, m = 0) => {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

function env(overrides: Partial<CalendarWindowEnv> = {}): CalendarWindowEnv {
  return {
    getCalendar: () => CAL,
    horizonStartMs: atTime(MON, 0),
    horizonEndMs: atTime(new Date(2026, 5, 30), 23, 59),
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;

describe('timeToMinutes', () => {
  it('parses HH:mm, treats 24:00 as 1440, and clamps', () => {
    expect(timeToMinutes('08:30')).toBe(510);
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(timeToMinutes(undefined)).toBe(0);
    expect(timeToMinutes('99:99')).toBe(1440);
  });
});

describe('getProductiveWindowsForDate', () => {
  it('returns the shift span on a working day', () => {
    const windows = getProductiveWindowsForDate(CAL, MON);
    expect(windows).toHaveLength(1);
    expect(windows[0].startMs).toBe(atTime(MON, 8));
    expect(windows[0].endMs).toBe(atTime(MON, 16));
  });

  it('returns [] on a non-working day', () => {
    expect(getProductiveWindowsForDate(CAL, SAT)).toHaveLength(0);
  });

  it('uses only schedulable diversions when a shift defines them', () => {
    const cal = {
      workingDays: [1, 2, 3, 4, 5],
      shifts: [{
        startTime: '08:00',
        endTime: '16:00',
        diversions: [
          { startTime: '08:00', endTime: '10:00', schedulable: true },
          { startTime: '10:00', endTime: '11:00', schedulable: false }, // maintenance
          { startTime: '11:00', endTime: '16:00', schedulable: true },
        ],
      }],
    };
    const windows = getProductiveWindowsForDate(cal, MON);
    expect(windows).toHaveLength(2);
    expect(windows[0].endMs).toBe(atTime(MON, 10));
    expect(windows[1].startMs).toBe(atTime(MON, 11));
  });

  it('falls back to Mon–Fri 08:00–16:00 when calendar data is missing', () => {
    const windows = getProductiveWindowsForDate(undefined, MON);
    expect(windows).toHaveLength(1);
    expect(windows[0].startMs).toBe(atTime(MON, 8));
  });
});

describe('alignToProductiveWindow', () => {
  it('keeps a candidate already inside a shift', () => {
    expect(alignToProductiveWindow(env(), atTime(MON, 10), 'WC-A')).toBe(atTime(MON, 10));
  });

  it('snaps a pre-shift candidate to shift start', () => {
    expect(alignToProductiveWindow(env(), atTime(MON, 6), 'WC-A')).toBe(atTime(MON, 8));
  });

  it('rolls a Saturday candidate to Monday shift start', () => {
    const aligned = alignToProductiveWindow(env(), atTime(SAT, 9), 'WC-A');
    expect(aligned).toBe(atTime(new Date(2026, 5, 8), 8)); // next Monday 08:00
  });

  it('passes through when the workcentre has no calendar', () => {
    const e = env({ getCalendar: () => undefined });
    expect(alignToProductiveWindow(e, atTime(SAT, 9), 'WC-A')).toBe(atTime(SAT, 9));
  });
});

describe('calculateProductiveEndMs', () => {
  it('finishes inside the same shift when it fits', () => {
    const end = calculateProductiveEndMs(env(), atTime(MON, 8), 2 * HOUR, 'WC-A');
    expect(end).toBe(atTime(MON, 10));
  });

  it('spills the remainder into the next working day', () => {
    // 10 booked hours from Mon 08:00: 8h Monday + 2h Tuesday → Tue 10:00ish
    const end = calculateProductiveEndMs(env(), atTime(MON, 8), 10 * HOUR, 'WC-A');
    const tue = new Date(2026, 5, 2);
    expect(end).toBeGreaterThanOrEqual(atTime(tue, 10));
    expect(end).toBeLessThanOrEqual(atTime(tue, 10, 5)); // small cursor increments allowed
  });

  it('skips the weekend when spilling from Friday', () => {
    const fri = new Date(2026, 5, 5);
    const end = calculateProductiveEndMs(env(), atTime(fri, 14), 4 * HOUR, 'WC-A');
    const mon8 = new Date(2026, 5, 8);
    expect(end).toBeGreaterThanOrEqual(atTime(mon8, 10));
    expect(end).toBeLessThanOrEqual(atTime(mon8, 10, 5));
  });

  it('falls back to wall-clock past the horizon or without a calendar', () => {
    const past = env().horizonEndMs + HOUR;
    expect(calculateProductiveEndMs(env(), past, HOUR, 'WC-A')).toBe(past + HOUR);
    const e = env({ getCalendar: () => undefined });
    expect(calculateProductiveEndMs(e, atTime(MON, 8), HOUR, 'WC-A')).toBe(atTime(MON, 9));
  });
});
