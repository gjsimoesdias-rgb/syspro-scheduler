/**
 * Master/sub-job precedence tests (SYSPRO WipMasterSub).
 *
 * A sub-job feeds its master job, so every sub-job must finish before the
 * master's first operation may start — in both scheduling directions.
 */

import { SchedulingEngine, SchedulingContext } from '../SchedulingEngine';
import { Job, Operation, Workcentre, Resource, Material } from '../../types';

// ---------------------------------------------------------------------------
// Helpers (mirrors SchedulingEngine.test.ts)
// ---------------------------------------------------------------------------

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
  extra: Partial<Job> = {},
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
    ...extra,
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

const DAY = new Date('2026-06-01T08:00:00.000Z'); // Monday
const HORIZON_END = new Date('2026-06-30T16:00:00.000Z');

function familyFixture() {
  // Two workcentres so master and subs don't just serialize by capacity.
  const wcA = makeWorkcentre('WC-A');
  const wcB = makeWorkcentre('WC-B');
  const resA = makeResource('R-A', 'WC-A');
  const resB = makeResource('R-B', 'WC-B');

  const sub1 = makeJob(
    'SUB-1',
    [makeOperation('SUB-1-OP10', 'SUB-1', 10, 'WC-A', 60)],
    DAY,
    HORIZON_END,
    { masterJobId: 'MST-1', isSubJob: true },
  );
  const sub2 = makeJob(
    'SUB-2',
    [makeOperation('SUB-2-OP10', 'SUB-2', 10, 'WC-A', 120)],
    DAY,
    HORIZON_END,
    { masterJobId: 'MST-1', isSubJob: true },
  );
  const master = makeJob(
    'MST-1',
    [makeOperation('MST-1-OP10', 'MST-1', 10, 'WC-B', 60)],
    DAY,
    HORIZON_END,
    { isMasterJob: true },
  );

  return { master, sub1, sub2, workcentres: [wcA, wcB], resources: [resA, resB] };
}

function byJob(schedule: { jobSchedules: any[] }, jobId: string) {
  return schedule.jobSchedules.find((j: any) => j.jobId === jobId);
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

describe('SchedulingEngine — master/sub precedence (forward)', () => {
  it('master starts only after every sub-job has finished', async () => {
    const { master, sub1, sub2, workcentres, resources } = familyFixture();
    const engine = new SchedulingEngine();

    // Deliberately pass the master FIRST — the engine must reorder.
    const ctx = makeContext([master, sub1, sub2], workcentres, resources, DAY, HORIZON_END);
    const schedule = await engine.schedule(ctx);

    const masterSched = byJob(schedule, 'MST-1');
    const sub1Sched = byJob(schedule, 'SUB-1');
    const sub2Sched = byJob(schedule, 'SUB-2');

    expect(masterSched.operationSchedules.length).toBeGreaterThan(0);
    expect(sub1Sched.operationSchedules.length).toBeGreaterThan(0);
    expect(sub2Sched.operationSchedules.length).toBeGreaterThan(0);

    const masterStart = new Date(masterSched.plannedStartDate).getTime();
    expect(masterStart).toBeGreaterThanOrEqual(new Date(sub1Sched.plannedEndDate).getTime());
    expect(masterStart).toBeGreaterThanOrEqual(new Date(sub2Sched.plannedEndDate).getTime());
  });

  it('jobs without a master are unaffected by the reorder', async () => {
    const { master, sub1, workcentres, resources } = familyFixture();
    const solo = makeJob(
      'SOLO-1',
      [makeOperation('SOLO-1-OP10', 'SOLO-1', 10, 'WC-B', 30)],
      DAY,
      HORIZON_END,
    );
    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(
      makeContext([solo, master, sub1], workcentres, resources, DAY, HORIZON_END),
    );

    expect(byJob(schedule, 'SOLO-1').operationSchedules.length).toBeGreaterThan(0);
    expect(schedule.jobSchedules).toHaveLength(3);
  });

  it('a masterJobId pointing outside the run is ignored (no crash, no constraint)', async () => {
    const { workcentres, resources } = familyFixture();
    const orphan = makeJob(
      'ORPH-1',
      [makeOperation('ORPH-1-OP10', 'ORPH-1', 10, 'WC-A', 30)],
      DAY,
      HORIZON_END,
      { masterJobId: 'NOT-IN-RUN', isSubJob: true },
    );
    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(
      makeContext([orphan], workcentres, resources, DAY, HORIZON_END),
    );

    expect(byJob(schedule, 'ORPH-1').operationSchedules.length).toBeGreaterThan(0);
    expect(
      schedule.constraintViolations.filter((v) => v.type === 'MasterJobPrecedence'),
    ).toHaveLength(0);
  });

  it('emits a MasterJobPrecedence warning when a sub-job cannot be scheduled', async () => {
    const { master, workcentres, resources } = familyFixture();
    // Sub-job on a workcentre that has no resource and no calendar → unschedulable.
    const badSub = makeJob(
      'SUB-BAD',
      [makeOperation('SUB-BAD-OP10', 'SUB-BAD', 10, 'WC-MISSING', 60)],
      DAY,
      HORIZON_END,
      { masterJobId: 'MST-1', isSubJob: true },
    );
    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(
      makeContext([master, badSub], workcentres, resources, DAY, HORIZON_END),
    );

    const warnings = schedule.constraintViolations.filter(
      (v) => v.type === 'MasterJobPrecedence',
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].affectedJobId).toBe('MST-1');
    expect(warnings[0].description).toContain('SUB-BAD');
  });
});

// ---------------------------------------------------------------------------
// Backward
// ---------------------------------------------------------------------------

describe('SchedulingEngine — master/sub precedence (backward)', () => {
  it('sub-jobs end before the master starts when scheduling backward', async () => {
    const { master, sub1, sub2, workcentres, resources } = familyFixture();
    const engine = new SchedulingEngine();

    // Pass subs first — backward ordering must hoist the master.
    const ctx = makeContext([sub1, sub2, master], workcentres, resources, DAY, HORIZON_END, {
      schedulingDirection: 'backward',
    });
    const schedule = await engine.schedule(ctx);

    const masterSched = byJob(schedule, 'MST-1');
    const sub1Sched = byJob(schedule, 'SUB-1');
    const sub2Sched = byJob(schedule, 'SUB-2');

    expect(masterSched.operationSchedules.length).toBeGreaterThan(0);
    expect(sub1Sched.operationSchedules.length).toBeGreaterThan(0);
    expect(sub2Sched.operationSchedules.length).toBeGreaterThan(0);

    const masterStart = new Date(masterSched.plannedStartDate).getTime();
    expect(new Date(sub1Sched.plannedEndDate).getTime()).toBeLessThanOrEqual(masterStart);
    expect(new Date(sub2Sched.plannedEndDate).getTime()).toBeLessThanOrEqual(masterStart);
  });
});

// ---------------------------------------------------------------------------
// Nested hierarchies: a sub-job that is itself a master (TOP <- M1 <- S2).
// Precedence must chain transitively through the middle tier in both
// directions (verified 2026-07 via a live-engine harness; kept here as
// permanent regression coverage).
// ---------------------------------------------------------------------------

describe('SchedulingEngine — nested master/sub chains (sub of sub)', () => {
  function chainFixture() {
    const wcA = makeWorkcentre('WC-A');
    const wcB = makeWorkcentre('WC-B');
    const wcC = makeWorkcentre('WC-C');
    const resources = [makeResource('R-A', 'WC-A'), makeResource('R-B', 'WC-B'), makeResource('R-C', 'WC-C')];
    const release = DAY;
    const due = HORIZON_END;

    const top = makeJob('TOP-1', [makeOperation('t-op1', 'TOP-1', 1, 'WC-A', 240)], release, due);
    const mid = makeJob('MID-1', [makeOperation('m-op1', 'MID-1', 1, 'WC-B', 240)], release, due, {
      masterJobId: 'TOP-1',
    } as any);
    const leaf = makeJob('LEAF-1', [makeOperation('l-op1', 'LEAF-1', 1, 'WC-C', 240)], release, due, {
      masterJobId: 'MID-1',
    } as any);

    return { jobs: [top, mid, leaf], workcentres: [wcA, wcB, wcC], resources };
  }

  const byId = (schedule: any, jobId: string) =>
    schedule.jobSchedules.find((j: any) => j.jobId === jobId);

  it('forward: precedence chains through the middle tier (LEAF ≤ MID ≤ TOP)', async () => {
    const { jobs, workcentres, resources } = chainFixture();
    const engine = new SchedulingEngine();
    // Pass TOP first — ordering must still hoist the deepest sub to the front.
    const ctx = makeContext(jobs, workcentres, resources, DAY, HORIZON_END);
    const schedule = await engine.schedule(ctx);

    const top = byId(schedule, 'TOP-1');
    const mid = byId(schedule, 'MID-1');
    const leaf = byId(schedule, 'LEAF-1');

    expect(top.operationSchedules.length).toBeGreaterThan(0);
    expect(mid.operationSchedules.length).toBeGreaterThan(0);
    expect(leaf.operationSchedules.length).toBeGreaterThan(0);

    expect(new Date(leaf.plannedEndDate).getTime()).toBeLessThanOrEqual(new Date(mid.plannedStartDate).getTime());
    expect(new Date(mid.plannedEndDate).getTime()).toBeLessThanOrEqual(new Date(top.plannedStartDate).getTime());
  });

  it('backward: precedence chains through the middle tier (LEAF ≤ MID ≤ TOP)', async () => {
    const { jobs, workcentres, resources } = chainFixture();
    const engine = new SchedulingEngine();
    // Pass the deepest sub first — backward ordering must hoist TOP to the front.
    const ctx = makeContext([...jobs].reverse(), workcentres, resources, DAY, HORIZON_END, {
      schedulingDirection: 'backward',
    });
    const schedule = await engine.schedule(ctx);

    const top = byId(schedule, 'TOP-1');
    const mid = byId(schedule, 'MID-1');
    const leaf = byId(schedule, 'LEAF-1');

    expect(top.operationSchedules.length).toBeGreaterThan(0);
    expect(mid.operationSchedules.length).toBeGreaterThan(0);
    expect(leaf.operationSchedules.length).toBeGreaterThan(0);

    expect(new Date(leaf.plannedEndDate).getTime()).toBeLessThanOrEqual(new Date(mid.plannedStartDate).getTime());
    expect(new Date(mid.plannedEndDate).getTime()).toBeLessThanOrEqual(new Date(top.plannedStartDate).getTime());
  });
});
