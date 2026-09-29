/**
 * Smoke tests for CalendarUtils — purely deterministic, no DB.
 * Acts as a safety net for any future scheduling-engine refactor that
 * touches working-day arithmetic.
 */

import CalendarUtils from './calendar';
import { Calendar } from '../types';

const mondayToFriday: Calendar = {
  calendarId: 'test-cal',
  name: 'Mon-Fri',
  workingDays: [1, 2, 3, 4, 5],
  workingHoursPerDay: 8,
  shifts: [],
  holidays: [],
};

const withChristmasHoliday: Calendar = {
  calendarId: 'test-cal-xmas',
  name: 'Mon-Fri with Christmas',
  workingDays: [1, 2, 3, 4, 5],
  workingHoursPerDay: 8,
  shifts: [],
  holidays: [{ date: new Date('2026-12-25T00:00:00Z'), isWorking: false } as any],
};

describe('CalendarUtils.isWorkingDay', () => {
  it('treats Saturday and Sunday as non-working with a Mon-Fri calendar', () => {
    expect(CalendarUtils.isWorkingDay(new Date('2026-05-02T10:00:00Z'), mondayToFriday)).toBe(false); // Sat
    expect(CalendarUtils.isWorkingDay(new Date('2026-05-03T10:00:00Z'), mondayToFriday)).toBe(false); // Sun
  });

  it('treats Monday-Friday as working', () => {
    expect(CalendarUtils.isWorkingDay(new Date('2026-05-04T10:00:00Z'), mondayToFriday)).toBe(true); // Mon
    expect(CalendarUtils.isWorkingDay(new Date('2026-05-08T10:00:00Z'), mondayToFriday)).toBe(true); // Fri
  });

  it('respects holidays flagged as non-working', () => {
    expect(
      CalendarUtils.isWorkingDay(new Date('2026-12-25T10:00:00Z'), withChristmasHoliday)
    ).toBe(false);
  });
});

describe('CalendarUtils.getNextWorkingDay', () => {
  it('skips the weekend', () => {
    const friday = new Date('2026-05-08T10:00:00Z');
    const next = CalendarUtils.getNextWorkingDay(friday, mondayToFriday);
    // Monday May 11, 2026
    expect(next.getDay()).toBe(1);
  });
});

describe('CalendarUtils.addWorkingDays', () => {
  it('adds N working days, skipping non-working days', () => {
    const monday = new Date('2026-05-04T10:00:00Z');
    const result = CalendarUtils.addWorkingDays(monday, 5, mondayToFriday);
    // 5 working days after Monday → next Monday
    expect(result.getDay()).toBe(1);
  });
});
