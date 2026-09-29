/**
 * Phase 3 correctness tests (2026-09-30):
 *  - backward scheduling books capacity (two jobs never overlap on one line)
 *  - subcontract ops take elapsed calendar time and book no machine
 *  - overtime is bucketed by local day
 *  - SYSPRO operation status / subcontract field mapping
 */
import { SchedulingEngine, SchedulingContext, localDayKey } from '../SchedulingEngine';
import { deriveOperationStatus, subcontractFields } from '../SysproDatabaseService';
import { Job, Operation, Workcentre, Resource, Material } from '../../types';

function makeCalendar(startTime = '08:00', endTime = '16:00', workingDays = [1, 2, 3, 4, 5]) {
  return {
    calendarId: 'cal-1',
    name: 'Standard',
    workingDays,
    workingHoursPerDay: 8,
    shifts: [{ shiftId: 's1', name: 'Day', startTime, endTime, breakTime: 0 }],
    holidays: [],
  };
}

function makeResource(id: string, workcentreId: string): Resource {
  return {
    resourceId: id,
    name: `Resource ${id}`,
    type: 'Machine',
    worcentreId: workcentreId,
    skillTags: [],
    costPerHour: 50,
    calendar: makeCalendar(),
    status: 'Available',
  };
}

function makeWorkcentre(id: string, maxOvertimePerDay = 0): Workcentre {
  return {
    worcentreId: id,
    name: `WC ${id}`,
    description: '',
    capabilities: [],
    shiftProfile: { name: 'Standard', shifts: [], weeksPerCycle: 1 },
    calendar: makeCalendar(),
    costPerHour: 80,
    maxOvertimePerDay,
  };
}

function makeOperation(opId: string, jobId: string, seq: number, wcId: string, durationMins: number): Operation {
  return {
    opId,
    jobId,
    sequence: seq,
    workcentreId: wcId,
    workcentreName: `WC ${wcId}`,
    duration: durationMins,
    setupTime: 0,
    queueTime: 0,
    moveTime: 0,
    batchSize: 1,
    qualifiedResourceIds: [],
    status: 'NotStarted',
  };
}

function makeJob(
  jobId: string,
  operations: Operation[],
  releaseDate: Date,
  dueDate: Date,
): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: `Job ${jobId}`,
    quantity: 10,
    dueDate,
    releaseDate,
    priority: 5,
    status: 'Released',
    operations,
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0,
  };
}

function makeContext(
  jobs: Job[],
  workcentres: Workcentre[],
  resources: Resource[],
  horizonStart: Date,
  horizonEnd: Date,
  overrides: Partial<SchedulingContext> = {},
): SchedulingContext {
  const wcMap = new Map(workcentres.map((wc) => [wc.worcentreId, wc]));
  const resMap = new Map(resources.map((r) => [r.resourceId, r]));
  return {
    jobs,
    workcentres: wcMap,
    resources: resMap,
    materials: new Map<string, Material>(),
    planningHorizonStart: horizonStart,
    planningHorizonEnd: horizonEnd,
    schedulingRule: 'priority',
    schedulingDirection: 'forward',
    ...overrides,
  };
}

// Monday 2026-06-01 08:00 UTC (a weekday)
const DAY = new Date('2026-06-01T08:00:00.000Z');
const HORIZON_END = new Date('2026-06-30T16:00:00.000Z');


const overlaps = (a: any, b: any) =>
  new Date(a.plannedStartDate) < new Date(b.plannedEndDate) && new Date(b.plannedStartDate) < new Date(a.plannedEndDate);

describe('backward scheduling respects capacity', () => {
  it('two jobs due at the same time on one line do not overlap', async () => {
    const wc = makeWorkcentre('WC01');
    const res = makeResource('R01', 'WC01');
    const due = new Date('2026-06-10T16:00:00.000Z');
    const jobs = ['J1', 'J2'].map((id) => {
      const op = makeOperation(`${id}-OP10`, id, 10, 'WC01', 120);
      op.qualifiedResourceIds = ['R01'];
      return makeJob(id, [op], DAY, due);
    });
    const ctx = makeContext(jobs, [wc], [res], DAY, HORIZON_END, { schedulingDirection: 'backward' });
    const schedule = await new SchedulingEngine().schedule(ctx);
    const [a, b] = schedule.jobSchedules.map((j) => j.operationSchedules[0]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(overlaps(a, b)).toBe(false);
  });
});

describe('subcontract operations', () => {
  it('take elapsed calendar time and do not block the line', async () => {
    const wc = makeWorkcentre('WC01');
    const res = makeResource('R01', 'WC01');
    const sub = makeOperation('J1-OP20', 'J1', 20, 'WC01', 60);
    sub.qualifiedResourceIds = ['R01'];
    sub.isSubcontract = true;
    sub.subcontractSupplier = 'ACME';
    sub.elapsedMinutes = 3 * 24 * 60; // 3 days
    const job1 = makeJob('J1', [sub], DAY, HORIZON_END);
    const op2 = makeOperation('J2-OP10', 'J2', 10, 'WC01', 60);
    op2.qualifiedResourceIds = ['R01'];
    const job2 = makeJob('J2', [op2], DAY, HORIZON_END);

    const ctx = makeContext([job1, job2], [wc], [res], DAY, HORIZON_END);
    const schedule = await new SchedulingEngine().schedule(ctx);
    const s = schedule.jobSchedules.find((j) => j.jobId === 'J1')!.operationSchedules[0];
    const o = schedule.jobSchedules.find((j) => j.jobId === 'J2')!.operationSchedules[0];

    expect(s.resourceId).toBe('SUB:ACME');
    expect(new Date(s.plannedEndDate).getTime() - new Date(s.plannedStartDate).getTime()).toBe(3 * 24 * 3600 * 1000);
    // J2 on the real line is free to overlap the supplier's 3 days
    expect(overlaps(s, o)).toBe(true);
  });
});

describe('SYSPRO field mapping', () => {
  it('OperCompleted = Y means Complete even when OperationStatus is blank', () => {
    expect(deriveOperationStatus({ OperCompleted: 'Y', status: 'NotStarted' })).toBe('Complete');
    expect(deriveOperationStatus({ OperCompleted: 'N', status: 'NotStarted' })).toBe('NotStarted');
    expect(deriveOperationStatus({ OperCompleted: ' ', status: '' })).toBe('NotStarted');
  });

  it('SubcontractOp = Y maps supplier and elapsed days to minutes', () => {
    expect(subcontractFields({ SubcontractOp: 'Y', SubSupplier: 'ACME ', ElapsedTime: 2 }))
      .toEqual({ isSubcontract: true, subcontractSupplier: 'ACME', elapsedMinutes: 2 * 24 * 60 });
    expect(subcontractFields({ SubcontractOp: 'N' })).toEqual({ isSubcontract: false });
  });
});

describe('localDayKey', () => {
  it('uses the local calendar day, not the UTC day', () => {
    const d = new Date(2026, 5, 2, 7, 30); // 2 June 07:30 local time
    expect(localDayKey(d)).toBe('2026-06-02');
  });
});
