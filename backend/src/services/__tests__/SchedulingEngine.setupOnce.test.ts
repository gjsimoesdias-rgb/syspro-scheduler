/**
 * Setup once per group (Settings → Setup → "Apply to the first job in the
 * autoscheduling group only"): same-item jobs run back-to-back without a
 * second setup, and are grouped together within the campaign window.
 */
import { SchedulingEngine, groupSameItemJobs } from '../SchedulingEngine';
import { ConstraintManager } from '../ConstraintManager';

const calendar = {
  calendarId: 'c', name: 'c', workingDays: [0, 1, 2, 3, 4, 5, 6], workingHoursPerDay: 24,
  shifts: [{ shiftId: 's', name: 's', startTime: '00:00', endTime: '24:00', breakTime: 0,
    diversions: [{ id: 'p', type: 'Production', startTime: '00:00', endTime: '24:00', schedulable: true }] }],
  holidays: [],
};
const start = new Date(2026, 8, 29);
const day = (n: number) => new Date(start.getTime() + n * 86_400_000);

const job = (id: string, item: string, dueDay: number) => ({
  jobId: id, itemCode: item, description: '', quantity: 1, releaseDate: start, dueDate: day(dueDay), priority: 5,
  status: 'Released', estimatedMaterialCost: 0, estimatedLaborCost: 0,
  operations: [{ opId: `${id}-OP10`, jobId: id, sequence: 10, workcentreId: 'L1', workcentreName: 'L1', duration: 60,
    setupTime: 30, queueTime: 0, moveTime: 0, batchSize: 1, qualifiedResourceIds: ['R1'], status: 'NotStarted' }],
});

const ctx = (jobs: any[], setupOncePerGroup: boolean) => ({
  jobs,
  workcentres: new Map([['L1', { worcentreId: 'L1', name: 'L1', description: '', capabilities: [],
    shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 }, calendar, costPerHour: 0, maxOvertimePerDay: 3 }]]),
  resources: new Map([['R1', { resourceId: 'R1', name: 'R1', type: 'Machine', worcentreId: 'L1', skillTags: [], costPerHour: 0, calendar, status: 'Available' }]]),
  materials: new Map(), planningHorizonStart: start, planningHorizonEnd: day(14),
  schedulingRule: 'edd', schedulingDirection: 'forward',
  resourceCapacities: new Map([['R1', 1]]), workcentreCapacities: new Map([['L1', 1]]),
  ruleToggles: { useSetupTime: true, useQueueTime: true, useMoveTime: true, setupOncePerGroup },
} as any);

const run = async (jobs: any[], on: boolean, matrix: any[] = []) => {
  const cm = new ConstraintManager();
  if (matrix.length) cm.loadExternalSequences(matrix);
  const s = await new SchedulingEngine(cm).schedule(ctx(jobs, on));
  return s.jobSchedules
    .map((j: any) => ({ id: j.jobId, op: j.operationSchedules[0] }))
    .sort((a: any, b: any) => +new Date(a.op.plannedStartDate) - +new Date(b.op.plannedStartDate));
};

describe('setup once per group', () => {
  const jobs = () => [job('A1', 'ITEM-A', 1), job('B1', 'ITEM-B', 2), job('A2', 'ITEM-A', 3)];

  it('off: EDD order, every job pays its setup', async () => {
    const r = await run(jobs(), false);
    expect(r.map((x: any) => x.id)).toEqual(['A1', 'B1', 'A2']);
    expect(r.map((x: any) => x.op.setupTime)).toEqual([30, 30, 30]);
  });

  it('on: same-item jobs are grouped and the second one skips setup', async () => {
    const r = await run(jobs(), true);
    expect(r.map((x: any) => x.id)).toEqual(['A1', 'A2', 'B1']);
    expect(r.map((x: any) => x.op.setupTime)).toEqual([30, 0, 30]);
  });

  it('an explicit same-item matrix entry still applies', async () => {
    const r = await run(jobs(), true, [{ fromItemCode: 'ITEM-A', toItemCode: 'ITEM-A', setupTimeMinutes: 10 }]);
    expect(r[1].id).toBe('A2');
    expect(r[1].op.setupTime).toBe(10);
  });
});

describe('groupSameItemJobs', () => {
  it('only pulls jobs due within the window', () => {
    const out = groupSameItemJobs([job('A1', 'A', 1), job('B1', 'B', 2), job('A2', 'A', 3), job('A3', 'A', 20)] as any, 7);
    expect(out.map((j) => j.jobId)).toEqual(['A1', 'A2', 'B1', 'A3']);
  });
});

describe('setup once per group — SYSPRO minor setup', () => {
  it('the second same-item job uses the operation minor setup', async () => {
    const withMinor = (j: any) => ({ ...j, operations: j.operations.map((o: any) => ({ ...o, minorSetupTime: 5 })) });
    const r = await run([withMinor(job('A1', 'ITEM-A', 1)), withMinor(job('A2', 'ITEM-A', 2))], true);
    expect(r.map((x: any) => x.op.setupTime)).toEqual([30, 5]);
  });
});
