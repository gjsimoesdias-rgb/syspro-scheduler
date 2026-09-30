/**
 * CtpService — capable-to-promise placement engine tests.
 *
 * Window semantics must mirror SchedulingEngine.getProductiveWindowsForDay:
 * Mon–Fri default, 08:00–16:00 default shift, schedulable diversions only.
 */
import { computeCtp, findEarliestSlot, windowsForDay, CtpResourceInfo } from '../CtpService';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Monday 2026-07-13 08:00 local. */
const monday8 = new Date(2026, 6, 13, 8, 0, 0, 0);
const mondayMidnight = new Date(2026, 6, 13, 0, 0, 0, 0).getTime();

const machine = (id: string, wc: string, withCalendar = true): CtpResourceInfo => ({
  resourceId: id,
  worcentreId: wc,
  name: id,
  calendar: withCalendar
    ? {
        workingDays: [1, 2, 3, 4, 5],
        shifts: [{ startTime: '08:00', endTime: '16:00' }],
      }
    : undefined,
});

/** Resource shaped like the app's default shift template: a 00:00–23:59 shift
 * whose only schedulable time is the Production diversion 08:00–16:00. */
const diversionMachine = (id: string, wc: string): CtpResourceInfo => ({
  resourceId: id,
  worcentreId: wc,
  name: id,
  calendar: {
    workingDays: [1, 2, 3, 4, 5],
    shifts: [
      {
        startTime: '00:00',
        endTime: '23:59',
        diversions: [
          { type: 'Non Productive', startTime: '00:00', endTime: '08:00', schedulable: false },
          { type: 'Production', startTime: '08:00', endTime: '16:00', schedulable: true },
          { type: 'Non Productive', startTime: '16:00', endTime: '23:59', schedulable: false },
        ],
      },
    ],
  },
});

describe('windowsForDay', () => {
  it('uses schedulable diversions instead of raw shift bounds', () => {
    const wins = windowsForDay(diversionMachine('M1', 'WC1'), mondayMidnight);
    expect(wins).toHaveLength(1);
    expect(wins[0].start).toBe(mondayMidnight + 8 * HOUR);
    expect(wins[0].end).toBe(mondayMidnight + 16 * HOUR);
  });

  it('defaults to Mon–Fri 08:00–16:00 when the resource has no calendar', () => {
    const wins = windowsForDay(machine('M1', 'WC1', false), mondayMidnight);
    expect(wins).toHaveLength(1);
    expect(wins[0].start).toBe(mondayMidnight + 8 * HOUR);
    const saturday = mondayMidnight + 5 * 24 * HOUR;
    expect(windowsForDay(machine('M1', 'WC1', false), saturday)).toHaveLength(0);
  });
});

describe('findEarliestSlot', () => {
  it('places at notBefore when resource is free and inside a shift', () => {
    const slot = findEarliestSlot(machine('M1', 'WC1'), [], monday8.getTime(), 2 * HOUR, new Set());
    expect(slot).not.toBeNull();
    expect(slot!.start).toBe(monday8.getTime());
    expect(slot!.end).toBe(monday8.getTime() + 2 * HOUR);
  });

  it('pushes past a busy interval', () => {
    const busy = [{ start: monday8.getTime(), end: monday8.getTime() + 3 * HOUR }];
    const slot = findEarliestSlot(machine('M1', 'WC1'), busy, monday8.getTime(), 1 * HOUR, new Set());
    expect(slot!.start).toBe(monday8.getTime() + 3 * HOUR);
  });

  it('rolls to the next working day when the op does not fit today', () => {
    const monday17 = new Date(2026, 6, 13, 17, 0, 0, 0).getTime();
    const slot = findEarliestSlot(machine('M1', 'WC1'), [], monday17, 2 * HOUR, new Set());
    const tuesday8 = new Date(2026, 6, 14, 8, 0, 0, 0).getTime();
    expect(slot!.start).toBe(tuesday8);
  });

  it('skips the weekend', () => {
    const friday1530 = new Date(2026, 6, 17, 15, 30, 0, 0).getTime();
    const slot = findEarliestSlot(machine('M1', 'WC1'), [], friday1530, 2 * HOUR, new Set());
    const nextMonday8 = new Date(2026, 6, 20, 8, 0, 0, 0).getTime();
    expect(slot!.start).toBe(nextMonday8);
  });

  it('starting on a WEEKEND still respects the calendar (regression)', () => {
    // Sunday 2026-07-12 10:00 → must land Monday 08:00, NOT Sunday.
    const sunday10 = new Date(2026, 6, 12, 10, 0, 0, 0).getTime();
    const assumptions = new Set<string>();
    const slot = findEarliestSlot(machine('M1', 'WC1'), [], sunday10, 2 * HOUR, assumptions);
    expect(slot!.start).toBe(monday8.getTime());
    expect(Array.from(assumptions)).toHaveLength(0);
  });

  it('diversion-based calendar: does not place work in non-productive time', () => {
    // 2h op requested at 15:00 → only 1h of Production left today → Tuesday 08:00.
    const monday15 = new Date(2026, 6, 13, 15, 0, 0, 0).getTime();
    const slot = findEarliestSlot(diversionMachine('M1', 'WC1'), [], monday15, 2 * HOUR, new Set());
    expect(slot!.start).toBe(new Date(2026, 6, 14, 8, 0, 0, 0).getTime());
  });
});

describe('computeCtp', () => {
  it('chains operations with strict precedence and reserves simulated slots', () => {
    const result = computeCtp({
      operations: [
        { workcentreId: 'WC1', setupMinutes: 30, runMinutes: 90 },
        { workcentreId: 'WC2', setupMinutes: 0, runMinutes: 60 },
      ],
      resources: [machine('M1', 'WC1'), machine('M2', 'WC2')],
      busyByResource: new Map(),
      earliestStart: monday8,
    });

    expect(result.feasible).toBe(true);
    expect(result.placements).toHaveLength(2);
    const [op1, op2] = result.placements;
    expect(new Date(op2.start).getTime()).toBeGreaterThanOrEqual(new Date(op1.end).getTime());
    expect(result.promiseDate).toBe(op2.end);
  });

  it('picks the resource with the earliest finish among alternatives', () => {
    const busyM1 = [{ start: monday8.getTime(), end: monday8.getTime() + 6 * HOUR }];
    const result = computeCtp({
      operations: [{ workcentreId: 'WC1', setupMinutes: 0, runMinutes: 60 }],
      resources: [machine('M1', 'WC1'), machine('M2', 'WC1')],
      busyByResource: new Map([['M1', busyM1]]),
      earliestStart: monday8,
    });
    expect(result.feasible).toBe(true);
    expect(result.placements[0].resourceId).toBe('M2');
    expect(new Date(result.placements[0].start).getTime()).toBe(monday8.getTime());
  });

  it('reports infeasible when the workcentre has no resources', () => {
    const result = computeCtp({
      operations: [{ workcentreId: 'NOPE', setupMinutes: 0, runMinutes: 60 }],
      resources: [machine('M1', 'WC1')],
      busyByResource: new Map(),
      earliestStart: monday8,
    });
    expect(result.feasible).toBe(false);
    expect(result.promiseDate).toBeNull();
    expect(result.message).toContain('NOPE');
  });

  it('evaluates the desired due date', () => {
    const late = computeCtp({
      operations: [{ workcentreId: 'WC1', setupMinutes: 0, runMinutes: 60 }],
      resources: [machine('M1', 'WC1')],
      busyByResource: new Map(),
      earliestStart: monday8,
      desiredDueDate: new Date(monday8.getTime() - 1 * HOUR),
    });
    expect(late.onTime).toBe(false);

    const ok = computeCtp({
      operations: [{ workcentreId: 'WC1', setupMinutes: 0, runMinutes: 60 }],
      resources: [machine('M1', 'WC1')],
      busyByResource: new Map(),
      earliestStart: monday8,
      desiredDueDate: new Date(monday8.getTime() + 8 * HOUR),
    });
    expect(ok.onTime).toBe(true);
  });

  it('relaxes the calendar (with a note) for ops longer than any shift window', () => {
    const result = computeCtp({
      operations: [{ workcentreId: 'WC1', setupMinutes: 0, runMinutes: 10 * 60 }], // 10h > 8h shift
      resources: [machine('M1', 'WC1')],
      busyByResource: new Map(),
      earliestStart: monday8,
    });
    expect(result.feasible).toBe(true);
    expect(result.assumptions.some((a) => a.includes('longer than the longest shift window'))).toBe(true);
  });
});

describe('ConstraintManager workcentre-aware setup matrix', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ConstraintManager = require('../ConstraintManager').default;

  it('prefers workcentre-specific changeover over generic', () => {
    const cm = new ConstraintManager();
    cm.loadExternalSequences([
      { fromItemCode: 'A', toItemCode: 'B', setupTimeMinutes: 30 },
      { fromItemCode: 'A', toItemCode: 'B', setupTimeMinutes: 90, workcentreId: 'PAINT' },
    ]);
    expect(cm.getSequenceSetupTime('A', 'B')).toBe(30);
    expect(cm.getSequenceSetupTime('A', 'B', 'PAINT')).toBe(90);
    expect(cm.getSequenceSetupTime('A', 'B', 'CUT')).toBe(30); // falls back to generic
    expect(cm.getSequenceSetupTime('B', 'A')).toBeUndefined();
  });
});

describe('computeCtp — master/sub families', () => {
  const HOUR2 = 60 * 60 * 1000;
  const monday8b = new Date(2026, 6, 13, 8, 0, 0, 0);
  const mk = (id: string, wc: string): CtpResourceInfo => ({
    resourceId: id,
    worcentreId: wc,
    name: id,
    calendar: { workingDays: [1, 2, 3, 4, 5], shifts: [{ startTime: '08:00', endTime: '16:00' }] },
  });

  it('master starts only after the SLOWEST sub-job finishes', () => {
    const result = computeCtp({
      operations: [{ workcentreId: 'ASSY', setupMinutes: 0, runMinutes: 60 }],
      subRoutings: [
        { label: 'SUB-A', operations: [{ workcentreId: 'CUT', setupMinutes: 0, runMinutes: 60 }] },
        { label: 'SUB-B', operations: [{ workcentreId: 'WELD', setupMinutes: 0, runMinutes: 240 }] },
      ],
      resources: [mk('M-CUT', 'CUT'), mk('M-WELD', 'WELD'), mk('M-ASSY', 'ASSY')],
      busyByResource: new Map(),
      earliestStart: monday8b,
    });

    expect(result.feasible).toBe(true);
    // Subs start in parallel on different machines.
    const subA = result.placements.find((p) => p.leg === 'SUB-A')!;
    const subB = result.placements.find((p) => p.leg === 'SUB-B')!;
    expect(new Date(subA.start).getTime()).toBe(monday8b.getTime());
    expect(new Date(subB.start).getTime()).toBe(monday8b.getTime());
    // Master waits for the 4h sub, not the 1h one.
    const master = result.placements.find((p) => p.leg === 'Master')!;
    expect(new Date(master.start).getTime()).toBe(monday8b.getTime() + 4 * HOUR2);
    expect(result.masterStart).toBe(new Date(monday8b.getTime() + 4 * HOUR2).toISOString());
    expect(result.promiseDate).toBe(master.end);
    expect(result.legEnds).toHaveLength(2);
  });

  it('sub-jobs competing for ONE machine serialise instead of overlapping', () => {
    const result = computeCtp({
      operations: [{ workcentreId: 'ASSY', setupMinutes: 0, runMinutes: 60 }],
      subRoutings: [
        { label: 'SUB-A', operations: [{ workcentreId: 'CUT', setupMinutes: 0, runMinutes: 120 }] },
        { label: 'SUB-B', operations: [{ workcentreId: 'CUT', setupMinutes: 0, runMinutes: 120 }] },
      ],
      resources: [mk('M-CUT', 'CUT'), mk('M-ASSY', 'ASSY')],
      busyByResource: new Map(),
      earliestStart: monday8b,
    });

    const subA = result.placements.find((p) => p.leg === 'SUB-A')!;
    const subB = result.placements.find((p) => p.leg === 'SUB-B')!;
    const aEnd = new Date(subA.end).getTime();
    const bStart = new Date(subB.start).getTime();
    expect(bStart).toBeGreaterThanOrEqual(aEnd); // no double-booking of M-CUT
    // Master starts after the later sub (12:00).
    expect(result.masterStart).toBe(new Date(monday8b.getTime() + 4 * HOUR2).toISOString());
  });

  it('fails with a leg-specific message when a sub workcentre is unknown', () => {
    const result = computeCtp({
      operations: [{ workcentreId: 'ASSY', setupMinutes: 0, runMinutes: 60 }],
      subRoutings: [{ label: 'SUB-X', operations: [{ workcentreId: 'GHOST', setupMinutes: 0, runMinutes: 30 }] }],
      resources: [mk('M-ASSY', 'ASSY')],
      busyByResource: new Map(),
      earliestStart: monday8b,
    });
    expect(result.feasible).toBe(false);
    expect(result.message).toContain('SUB-X');
    expect(result.message).toContain('GHOST');
  });
});
