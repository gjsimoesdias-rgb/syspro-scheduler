/**
 * Live-data regression (2026-09-30): operations longer than one shift window
 * were flagged as overtime *in full* and rejected against the 3 h/day overtime
 * budget, so 19 of 33 jobs stayed unscheduled with "Could not find available slot".
 */
import { SchedulingEngine } from '../SchedulingEngine';

const cal = (diversions: any[]) => ({
  calendarId: 'c', name: 'c', workingDays: [1, 2, 3, 4, 5], workingHoursPerDay: 24,
  shifts: [{ shiftId: 's', name: 's', startTime: '00:00', endTime: '23:59', breakTime: 0, diversions }],
  holidays: [],
});
const DAY24 = [{ id: 'p', type: 'Production', startTime: '00:00', endTime: '23:59', schedulable: true }];

const ctxFor = (calendar: any, minutes: number) => {
  const op = { opId: 'J1-OP10', jobId: 'J1', sequence: 10, workcentreId: 'L1', workcentreName: 'L1', duration: minutes, setupTime: 0,
    queueTime: 0, moveTime: 0, batchSize: 1, qualifiedResourceIds: ['R1'], status: 'NotStarted' };
  const start = new Date(2026, 8, 29); // Tue 29 Sep, local
  return {
    jobs: [{ jobId: 'J1', itemCode: 'I', description: '', quantity: 1, releaseDate: start, dueDate: new Date(2026, 9, 30), priority: 5,
      status: 'Released', estimatedMaterialCost: 0, estimatedLaborCost: 0, operations: [op] }],
    workcentres: new Map([['L1', { worcentreId: 'L1', name: 'L1', description: '', capabilities: [], shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 }, calendar, costPerHour: 0, maxOvertimePerDay: 3 }]]),
    resources: new Map([['R1', { resourceId: 'R1', name: 'R1', type: 'Machine', worcentreId: 'L1', skillTags: [], costPerHour: 0, calendar, status: 'Available' }]]),
    materials: new Map(), planningHorizonStart: start, planningHorizonEnd: new Date(2026, 9, 13, 23, 59),
    schedulingRule: 'edd', schedulingDirection: 'forward',
    resourceCapacities: new Map([['R1', 1]]), workcentreCapacities: new Map([['L1', 1]]),
  } as any;
};

describe('multi-day operations', () => {
  it('a 50 h operation on a 24 h Mon–Fri calendar is scheduled, not rejected as overtime', async () => {
    const s = await new SchedulingEngine().schedule(ctxFor(cal(DAY24), 2975));
    const ops = s.jobSchedules[0].operationSchedules;
    expect(ops).toHaveLength(1);
    expect(s.constraintViolations.filter((v: any) => v.type === 'CapacityExceeded')).toHaveLength(0);
    // Spread over the days it runs, never more than a day's shift on one day.
    for (const load of s.resourceLoads) expect(load.regularHours).toBeLessThanOrEqual(24);
    expect(s.resourceLoads.filter((l: any) => l.regularHours > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('only time inside an Overtime diversion counts as overtime', async () => {
    const withOt = cal([
      { id: 'p', type: 'Production', startTime: '06:00', endTime: '14:00', schedulable: true },
      { id: 'o', type: 'Overtime', startTime: '14:00', endTime: '16:00', schedulable: true },
    ]);
    const s = await new SchedulingEngine().schedule(ctxFor(withOt, 9 * 60)); // 8 h regular + 1 h overtime
    const loads = s.resourceLoads.filter((l: any) => l.regularHours + l.overtimeHours > 0);
    expect(loads).toHaveLength(1);
    expect(loads[0].regularHours).toBeCloseTo(8, 5);
    expect(loads[0].overtimeHours).toBeCloseTo(1, 5);
  });

  it('an operation longer than the horizon says so', async () => {
    const s = await new SchedulingEngine().schedule(ctxFor(cal(DAY24), 31493));
    expect(s.jobSchedules[0].operationSchedules).toHaveLength(0);
    expect(s.constraintViolations[0].description).toMatch(/would finish after the planning horizon/);
  });
});
