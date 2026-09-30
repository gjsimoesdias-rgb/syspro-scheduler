/**
 * Operation overlap (Settings → Transfer/Overlap): the next operation starts
 * once a share of the previous run is done, but cannot finish before the last
 * transfer batch arrives.
 */
import { SchedulingEngine } from '../SchedulingEngine';

const calendar = {
  calendarId: 'c', name: 'c', workingDays: [0, 1, 2, 3, 4, 5, 6], workingHoursPerDay: 24,
  shifts: [{ shiftId: 's', name: 's', startTime: '00:00', endTime: '24:00', breakTime: 0,
    diversions: [{ id: 'p', type: 'Production', startTime: '00:00', endTime: '24:00', schedulable: true }] }],
  holidays: [],
};
const start = new Date(2026, 8, 29);
const wc = (id: string) => [id, { worcentreId: id, name: id, description: '', capabilities: [],
  shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 }, calendar, costPerHour: 0, maxOvertimePerDay: 3 }];
const res = (id: string, w: string) => [id, { resourceId: id, name: id, type: 'Machine', worcentreId: w, skillTags: [], costPerHour: 0, calendar, status: 'Available' }];
const op = (seq: number, w: string, r: string, run: number) => ({ opId: `J1-OP${seq}`, jobId: 'J1', sequence: seq, workcentreId: w,
  workcentreName: w, duration: run, setupTime: 0, queueTime: 0, moveTime: 0, batchSize: 1, qualifiedResourceIds: [r], status: 'NotStarted' });

const run = async (ops: any[], overlapFraction?: number) => {
  const ctx: any = {
    jobs: [{ jobId: 'J1', itemCode: 'I', description: '', quantity: 1, releaseDate: start, dueDate: new Date(2026, 9, 30),
      priority: 5, status: 'Released', estimatedMaterialCost: 0, estimatedLaborCost: 0, operations: ops }],
    workcentres: new Map([wc('L1'), wc('L2')] as any), resources: new Map([res('R1', 'L1'), res('R2', 'L2')] as any),
    materials: new Map(), planningHorizonStart: start, planningHorizonEnd: new Date(2026, 9, 13),
    schedulingRule: 'edd', schedulingDirection: 'forward',
    resourceCapacities: new Map([['R1', 1], ['R2', 1]]), workcentreCapacities: new Map([['L1', 1], ['L2', 1]]),
    ruleToggles: { useMoveTime: false, overlapFraction },
  };
  const s = await new SchedulingEngine().schedule(ctx);
  const j = s.jobSchedules[0];
  const o = j.operationSchedules.map((x: any) => ({ s: +new Date(x.plannedStartDate) - +start, e: +new Date(x.plannedEndDate) - +start }));
  return { o, jobEnd: +new Date(j.plannedEndDate) - +start };
};
const MIN = 60_000;

describe('operation overlap', () => {
  it('off: the second operation waits for the first to finish', async () => {
    const { o } = await run([op(10, 'L1', 'R1', 120), op(20, 'L2', 'R2', 120)]);
    expect(o[1].s).toBe(o[0].e);
  });

  it('25 %: the second operation starts after a quarter of the first run', async () => {
    const { o } = await run([op(10, 'L1', 'R1', 120), op(20, 'L2', 'R2', 120)], 0.25);
    expect(o[0].s).toBe(0);
    expect(o[1].s).toBe(30 * MIN);
    expect(o[1].e).toBe(150 * MIN);
  });

  it('a fast follower is pushed so it ends after the last batch arrives', async () => {
    // First run 240 min, second only 40 min: may not finish before 240 + 0.25*40.
    const { o, jobEnd } = await run([op(10, 'L1', 'R1', 240), op(20, 'L2', 'R2', 40)], 0.25);
    expect(o[1].e).toBeGreaterThanOrEqual(250 * MIN);
    expect(jobEnd).toBe(Math.max(o[0].e, o[1].e));
  });
});
