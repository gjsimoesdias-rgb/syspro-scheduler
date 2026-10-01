/** Crew size by shift: employees count only while their SYSPRO shift is working. */
import { CrewLoad } from '../crewLoad';
import { crewLookupFrom, capacityAt, shiftWorkingAt, shiftDefFromTemplate, normaliseCrewSetup } from '../../utils/crews';

const shifts = [
  { shiftId: 'shift-day', name: 'DAY', workingDays: [1, 2, 3, 4, 5], diversions: [{ startTime: '06:00', endTime: '14:00', schedulable: true }] },
  { shiftId: 'shift-night', name: 'NIGHT', workingDays: [1, 2, 3, 4, 5], startTime: '22:00', endTime: '06:00' },
];
const employees = [
  { code: 'E1', shiftId: 'DAY' }, { code: 'E2', shiftId: 'day' }, { code: 'E3', shiftId: 'NIGHT' },
  { code: 'E4' }, { code: 'E5', shiftId: 'UNKNOWN' },
];
const setup = normaliseCrewSetup({ enabled: true,
  pools: [{ name: 'Packing', headcount: 0, employees: ['E1', 'E2', 'E3', 'E4', 'E5'] }],
  lines: { L1: { poolId: 'packing', operators: 3 } } }) as any;
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m); // 5 Oct 2026 = Monday

describe('crew size by shift', () => {
  const lookup = crewLookupFrom(setup, employees, shifts)!;
  const cap = lookup.capacity!.get('packing')!;

  it('groups employees by CRUX shift (by name or id, case-insensitive); unknown shifts count always', () => {
    expect(cap.constant).toBe(2); // E4 no shift, E5 unknown shift
    expect(cap.shifts.map((s) => [s.name, s.count]).sort()).toEqual([['DAY', 2], ['NIGHT', 1]]);
  });

  it('capacity follows the shifts, including overnight and weekends', () => {
    expect(capacityAt(cap, at(5, 10))).toBe(4); // Mon 10:00 — day shift + 2 always
    expect(capacityAt(cap, at(5, 15))).toBe(2); // Mon 15:00 — nobody on shift
    expect(capacityAt(cap, at(5, 23))).toBe(3); // Mon 23:00 — night shift
    expect(capacityAt(cap, at(6, 3))).toBe(3);  // Tue 03:00 — Monday's night shift
    expect(capacityAt(cap, at(4, 10))).toBe(2); // Sun 10:00
  });

  it('a 3-operator line runs in the day shift, waits through the afternoon gap', () => {
    const load = new CrewLoad(lookup);
    expect(load.nextFreeAt('L1', at(5, 8), at(5, 12))).toBeNull();
    // 13:00–15:00 runs past the day shift's end at 14:00; nobody covers 14–15,
    // so no start before 15:00 can work — retry there.
    expect(load.nextFreeAt('L1', at(5, 13), at(5, 15))!.getTime()).toBe(at(5, 15).getTime());
    expect(load.nextFreeAt('L1', at(5, 22, 30), at(5, 23, 30))).toBeNull(); // night: 3 operators
  });

  it('without shift data every mapped employee counts all the time', () => {
    const plain = crewLookupFrom(setup)!;
    expect(plain.capacity).toBeUndefined();
    expect(plain.headcount.get('packing')).toBe(5);
  });

  it('shift helpers', () => {
    const def = shiftDefFromTemplate(shifts[1]);
    expect(def.windows).toEqual([[1320, 360]]);
    expect(shiftWorkingAt(def, at(6, 5, 59))).toBe(true);
    expect(shiftWorkingAt(def, at(6, 6, 0))).toBe(false);
    expect(shiftWorkingAt(def, at(10, 23))).toBe(false); // Saturday night: not a working day
  });
});
