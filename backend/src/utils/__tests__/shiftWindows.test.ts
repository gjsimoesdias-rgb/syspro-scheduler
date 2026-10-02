import { dayWindowMinutes, patternWindows } from '../shiftWindows';

// 2026-10-02 is a Friday; 03 Sat, 04 Sun, 05 Mon.
const d = (iso: string) => new Date(`${iso}T12:00:00`);
const night = {
  workingDays: [1, 2, 3, 4, 5],
  shifts: [{ diversions: [
    { startTime: '00:00', endTime: '06:00', schedulable: true, type: 'Production' },
    { startTime: '06:00', endTime: '22:00', schedulable: false, type: 'Non Productive' },
    { startTime: '22:00', endTime: '24:00', schedulable: true, type: 'Production' },
  ] }],
};
const minutes = (cal: any, iso: string) => dayWindowMinutes(cal, d(iso)).map((w) => [w.start, w.end]);

describe('dayWindowMinutes — night shifts', () => {
  it('Friday night keeps its Saturday-morning tail', () => {
    expect(minutes(night, '2026-10-02')).toEqual([[0, 360], [1320, 1440]]); // Fri: Thu-night tail + Fri night start
    expect(minutes(night, '2026-10-03')).toEqual([[0, 360]]);               // Sat: only Friday's tail
    expect(minutes(night, '2026-10-04')).toEqual([]);                       // Sun: nothing
  });

  it('Monday 00:00–06:00 is not worked (no Sunday night shift)', () => {
    expect(minutes(night, '2026-10-05')).toEqual([[1320, 1440]]);
  });

  it('a holiday on Friday also drops its tail on Saturday', () => {
    const cal = { ...night, holidays: [{ date: '2026-10-02', isWorking: false }] };
    expect(minutes(cal, '2026-10-02')).toEqual([]);
    expect(minutes(cal, '2026-10-03')).toEqual([]);
  });

  it('simple start/end shifts that cross midnight are split the same way', () => {
    const cal = { workingDays: [1, 2, 3, 4, 5], shifts: [{ startTime: '22:00', endTime: '06:00' }] };
    expect(patternWindows(cal).map((w) => [w.start, w.end])).toEqual([[0, 360], [1320, 1440]]);
    expect(minutes(cal, '2026-10-03')).toEqual([[0, 360]]);
  });
});

describe('dayWindowMinutes — unchanged behaviour for day shifts', () => {
  it('defaults to Mon–Fri 08:00–16:00', () => {
    expect(minutes({}, '2026-10-02')).toEqual([[480, 960]]);
    expect(minutes({}, '2026-10-03')).toEqual([]);
  });

  it('a shift that merely starts at 00:00 is not treated as a night-shift tail', () => {
    const cal = { shifts: [{ diversions: [{ startTime: '00:00', endTime: '08:00', schedulable: true }] }] };
    expect(minutes(cal, '2026-10-05')).toEqual([[0, 480]]); // Monday works its own 00:00–08:00
    expect(minutes(cal, '2026-10-03')).toEqual([]);
  });

  it('keeps the overtime flag of overtime diversions', () => {
    const cal = { shifts: [{ diversions: [{ startTime: '16:00', endTime: '18:00', schedulable: true, type: 'Overtime' }] }] };
    expect(dayWindowMinutes(cal, d('2026-10-02'))).toEqual([{ start: 960, end: 1080, overtime: true }]);
  });
});
