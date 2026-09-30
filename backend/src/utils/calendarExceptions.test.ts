import {
  applyCalendarExceptions,
  exceptionForDay,
  exceptionWindowMinutes,
  holidayKey,
  normaliseException,
} from './calendarExceptions';
import { windowsForDay } from '../services/CtpService';
import { SchedulingEngine } from '../services/SchedulingEngine';

const cal = (holidays: any[] = []) => ({
  workingDays: [1, 2, 3, 4, 5],
  shifts: [{ startTime: '08:00', endTime: '16:00' }],
  holidays,
});
// Local midnights (not UTC) — the plant's calendar day.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('calendar exceptions', () => {
  it('normalises input and rejects bad values', () => {
    expect(normaliseException({ date: '2026-12-25', name: 'Christmas' })).toMatchObject({
      date: '2026-12-25', name: 'Christmas', scope: 'plant', isWorking: false,
    });
    expect(normaliseException({ date: '25/12/2026', name: 'x' })).toBe('date must be YYYY-MM-DD');
    expect(normaliseException({ date: '2026-12-25' })).toBe('name is required');
    expect(normaliseException({ date: '2026-12-24', name: 'Short', startTime: '08:00' }))
      .toBe('set both startTime and endTime, or neither');
    expect(normaliseException({ date: '2026-12-24', name: 'Short', startTime: '12:00', endTime: '08:00' }))
      .toBe('endTime must be after startTime');
  });

  it('keys dates by local day whatever form they arrive in', () => {
    expect(holidayKey('2026-12-25')).toBe('2026-12-25');
    expect(holidayKey(day(2026, 12, 25))).toBe('2026-12-25');
  });

  it('closed / short / extra days map to the right windows', () => {
    expect(exceptionWindowMinutes({ isWorking: false })).toEqual([]);
    expect(exceptionWindowMinutes({ isWorking: true })).toBeNull();
    expect(exceptionWindowMinutes({ isWorking: true, startTime: '08:00', endTime: '12:00' }))
      .toEqual([{ start: 480, end: 720 }]);
  });

  it('a work-centre exception beats the plant one on the same day', () => {
    const [r] = applyCalendarExceptions([{ worcentreId: 'WC1', calendar: cal() }], [
      { id: 'a', date: '2026-12-24', name: 'Plant', scope: 'plant', isWorking: false },
      { id: 'b', date: '2026-12-24', name: 'WC1 works', scope: 'WC1', isWorking: true, startTime: '08:00', endTime: '12:00' },
      { id: 'c', date: '2026-12-24', name: 'Other line', scope: 'WC2', isWorking: false },
    ]);
    expect(r.calendar.holidays).toHaveLength(2);
    expect(exceptionForDay(r.calendar, day(2026, 12, 24)).name).toBe('WC1 works');
  });

  it('the engine and CTP both honour holidays, short days and extra days', () => {
    const calendar = cal([
      { date: '2026-12-25', isWorking: false },                                   // Fri, closed
      { date: '2026-12-24', isWorking: true, startTime: '08:00', endTime: '12:00' }, // Thu, short
      { date: '2026-12-26', isWorking: true },                                    // Sat, normal shift
    ]);
    const engine = new SchedulingEngine() as any;
    const hours = (d: Date) => engine.productiveHoursForDay(calendar, d);
    expect(hours(day(2026, 12, 23))).toBe(8);
    expect(hours(day(2026, 12, 24))).toBe(4);
    expect(hours(day(2026, 12, 25))).toBe(0);
    expect(hours(day(2026, 12, 26))).toBe(8);
    expect(hours(day(2026, 12, 27))).toBe(0);

    const ctpHours = (d: Date) => windowsForDay({ resourceId: 'R', worcentreId: 'W', calendar } as any, d.getTime())
      .reduce((h, w) => h + (w.end - w.start) / 3_600_000, 0);
    expect([23, 24, 25, 26, 27].map((d) => ctpHours(day(2026, 12, d)))).toEqual([8, 4, 0, 8, 0]);
  });
});
