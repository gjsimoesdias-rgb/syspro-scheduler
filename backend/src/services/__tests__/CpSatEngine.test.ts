/**
 * Unit tests for CpSatSchedulingEngine.
 *
 * Use a stubbed global fetch so the tests run hermetically — no Python
 * sidecar required.
 *
 * Coverage:
 *  - Happy path: well-formed SolveResponse → JobSchedule[] with correct shape
 *  - Sidecar reachable but returns INFEASIBLE → empty schedule + Critical violation
 *  - Sidecar reachable but returns no scheduled_operations → empty schedule + Critical violation
 *  - Sidecar HTTP 503 → empty schedule + Critical violation (graceful fallback)
 *  - Sidecar network failure / abort → empty schedule + Critical violation
 *  - Weight normalisation (0–100 in context → 0–1 in payload)
 *  - Unscheduled job IDs surface as ConstraintViolations on the Schedule
 */

import { CpSatSchedulingEngine } from '../CpSatEngine';
import type { SchedulingContext } from '../SchedulingEngine';
import { Job, Resource, Workcentre } from '../../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeJob(jobId: string, dueDate: Date, releaseDate?: Date): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    quantity: 1,
    dueDate,
    releaseDate: releaseDate ?? new Date('2026-05-11T00:00:00Z'),
    priority: 5,
    status: 'Released',
    operations: [
      {
        opId: `${jobId}-OP1`,
        jobId,
        sequence: 1,
        workcentreId: 'WC-A',
        workcentreName: 'WC-A',
        duration: 60,
        setupTime: 10,
        queueTime: 0,
        moveTime: 0,
        batchSize: 1,
        qualifiedResourceIds: ['R-A1'],
        status: 'NotStarted',
      },
    ],
  } as any;
}

function makeResource(id: string, workcentreId: string): Resource {
  return {
    resourceId: id,
    name: `Resource ${id}`,
    type: 'Machine',
    worcentreId: workcentreId,
    skillTags: [],
    costPerHour: 50,
    calendar: {
      calendarId: 'cal',
      name: 'std',
      workingDays: [1, 2, 3, 4, 5],
      workingHoursPerDay: 8,
      shifts: [],
      holidays: [],
    },
    status: 'Available',
  } as Resource;
}

function makeWorkcentre(id: string): Workcentre {
  return {
    worcentreId: id,
    name: `WC ${id}`,
    description: '',
    capabilities: [],
    shiftProfile: { name: 'std', shifts: [], weeksPerCycle: 1 },
    calendar: {
      calendarId: 'cal',
      name: 'std',
      workingDays: [1, 2, 3, 4, 5],
      workingHoursPerDay: 8,
      shifts: [],
      holidays: [],
    },
    costPerHour: 80,
    maxOvertimePerDay: 0,
  } as Workcentre;
}

function makeContext(jobs: Job[], resources: Resource[]): SchedulingContext {
  return {
    jobs,
    workcentres: new Map([['WC-A', makeWorkcentre('WC-A')]]),
    resources: new Map(resources.map((r) => [r.resourceId, r])),
    materials: new Map(),
    planningHorizonStart: new Date('2026-05-11T00:00:00Z'),
    planningHorizonEnd: new Date('2026-05-25T00:00:00Z'),
  } as SchedulingContext;
}

// ---------------------------------------------------------------------------
// fetch stubs
// ---------------------------------------------------------------------------

// We deliberately type each mock as `(url, init) =>` so `mock.calls[0][1]`
// gives us a `RequestInit` with a `.body` field — Jest's default inferrence
// would otherwise widen this to `[][]`.
type FetchArgs = [string, RequestInit];

/** Build a "fetch" that returns the given JSON body with status 200 unless overridden. */
const makeFetchOk = (body: any) =>
  jest.fn(async (..._args: FetchArgs) => ({
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  }));

const makeFetch503 = () =>
  jest.fn(async (..._args: FetchArgs) => ({
    ok: false,
    status: 503,
    async json() {
      return { detail: 'ortools not installed' };
    },
    async text() {
      return 'ortools not installed';
    },
  }));

const makeFetchThrow = (err: Error) =>
  jest.fn(async (..._args: FetchArgs) => {
    throw err;
  });

// Restore globals between tests
let originalFetch: typeof fetch | undefined;
beforeEach(() => {
  originalFetch = (global as any).fetch;
});
afterEach(() => {
  (global as any).fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('CpSatSchedulingEngine — happy path', () => {
  it('maps a well-formed SolveResponse into JobSchedule[]', async () => {
    const due = new Date('2026-05-20T00:00:00Z');
    const job = makeJob('J1', due);
    const ctx = makeContext([job], [makeResource('R-A1', 'WC-A')]);

    const startEpoch = Math.floor(new Date('2026-05-12T08:00:00Z').getTime() / 1000);
    const endEpoch = startEpoch + 60 * 70; // 70 minutes

    (global as any).fetch = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 12.5,
      tardiness_score: 0,
      makespan_minutes: 70,
      changeover_minutes: 0,
      scheduled_operations: [
        {
          op_id: 'J1-OP1',
          job_id: 'J1',
          resource_id: 'R-A1',
          workcentre_id: 'WC-A',
          start_epoch: startEpoch,
          end_epoch: endEpoch,
          setup_start_epoch: startEpoch,
          setup_end_epoch: startEpoch + 600,
          run_start_epoch: startEpoch + 600,
          run_end_epoch: endEpoch,
          queue_end_epoch: startEpoch,
          move_end_epoch: endEpoch,
          sequence: 1,
          is_overtime: false,
        },
      ],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.45,
      solver_status_code: 4,
    });

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    expect(schedule.jobSchedules).toHaveLength(1);
    const js = schedule.jobSchedules[0];
    expect(js.jobId).toBe('J1');
    expect(js.status).toBe('Scheduled');
    expect(js.operationSchedules).toHaveLength(1);
    expect(js.operationSchedules[0].opId).toBe('J1-OP1');
    expect(js.operationSchedules[0].resourceId).toBe('R-A1');
    expect(js.operationSchedules[0].plannedStartDate.getTime()).toBe(startEpoch * 1000);
    expect(js.operationSchedules[0].plannedEndDate.getTime()).toBe(endEpoch * 1000);
    expect(schedule.constraintViolations).toHaveLength(0);
  });

  it('normalises weights from 0–100 to 0–1 in the payload', async () => {
    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);
    ctx.cpSatWeights = { tardiness: 50, makespan: 30, changeover: 20 };

    const fetchSpy = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });
    (global as any).fetch = fetchSpy;

    const engine = new CpSatSchedulingEngine();
    await engine.schedule(ctx);

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.weights).toEqual({
      tardiness: 0.5,
      makespan: 0.3,
      changeover: 0.2,
    });
  });

  it('uses default 33/33/34 weights when none are supplied', async () => {
    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);

    const fetchSpy = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });
    (global as any).fetch = fetchSpy;

    const engine = new CpSatSchedulingEngine();
    await engine.schedule(ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.weights.tardiness).toBeCloseTo(0.33);
    expect(body.weights.makespan).toBeCloseTo(0.33);
    expect(body.weights.changeover).toBeCloseTo(0.34);
  });
});

// ---------------------------------------------------------------------------
// Solver failure / fallback paths
// ---------------------------------------------------------------------------

describe('CpSatSchedulingEngine — failure paths', () => {
  it('returns an empty schedule with a Critical violation when the sidecar 503s', async () => {
    (global as any).fetch = makeFetch503();
    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    expect(schedule.constraintViolations).toHaveLength(1);
    expect(schedule.constraintViolations[0].severity).toBe('Critical');
    expect(schedule.constraintViolations[0].description).toMatch(/sidecar/i);
    expect(schedule.jobSchedules.every((j) => j.operationSchedules.length === 0)).toBe(true);
  });

  it('returns an empty schedule with a Critical violation on network throw', async () => {
    (global as any).fetch = makeFetchThrow(new Error('ECONNREFUSED'));
    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    expect(schedule.constraintViolations).toHaveLength(1);
    expect(schedule.constraintViolations[0].severity).toBe('Critical');
    expect(schedule.constraintViolations[0].description).toMatch(/ECONNREFUSED/);
  });

  it('returns empty schedule when the solver returns INFEASIBLE', async () => {
    (global as any).fetch = makeFetchOk({
      status: 'INFEASIBLE',
      objective_value: null,
      tardiness_score: null,
      makespan_minutes: null,
      changeover_minutes: null,
      scheduled_operations: [],
      unscheduled_job_ids: ['J1'],
      solve_time_seconds: 0.05,
      solver_status_code: 3,
    });

    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    expect(schedule.constraintViolations.length).toBeGreaterThan(0);
    expect(schedule.constraintViolations[0].severity).toBe('Critical');
    expect(schedule.constraintViolations[0].description).toMatch(/INFEASIBLE/);
  });

  it('returns empty schedule when the solver returns zero operations even with status OPTIMAL', async () => {
    (global as any).fetch = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });

    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [makeResource('R-A1', 'WC-A')]);

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    // The engine treats zero operations identically to INFEASIBLE.
    expect(schedule.constraintViolations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unscheduled jobs → violations
// ---------------------------------------------------------------------------

describe('CpSatSchedulingEngine — unscheduled jobs', () => {
  it('surfaces every unscheduled job id as a Critical ConstraintViolation', async () => {
    const startEpoch = Math.floor(new Date('2026-05-12T08:00:00Z').getTime() / 1000);
    (global as any).fetch = makeFetchOk({
      status: 'FEASIBLE',
      objective_value: 5,
      tardiness_score: 1,
      makespan_minutes: 70,
      changeover_minutes: 0,
      scheduled_operations: [
        {
          op_id: 'J1-OP1',
          job_id: 'J1',
          resource_id: 'R-A1',
          workcentre_id: 'WC-A',
          start_epoch: startEpoch,
          end_epoch: startEpoch + 4200,
          setup_start_epoch: startEpoch,
          setup_end_epoch: startEpoch + 600,
          run_start_epoch: startEpoch + 600,
          run_end_epoch: startEpoch + 4200,
          queue_end_epoch: startEpoch,
          move_end_epoch: startEpoch + 4200,
          sequence: 1,
          is_overtime: false,
        },
      ],
      unscheduled_job_ids: ['J2', 'J3'],
      solve_time_seconds: 1.1,
      solver_status_code: 2,
    });

    const ctx = makeContext(
      [
        makeJob('J1', new Date('2026-05-20')),
        makeJob('J2', new Date('2026-05-20')),
        makeJob('J3', new Date('2026-05-20')),
      ],
      [makeResource('R-A1', 'WC-A')]
    );

    const engine = new CpSatSchedulingEngine();
    const schedule = await engine.schedule(ctx);

    const violationJobIds = schedule.constraintViolations
      .filter((v) => v.severity === 'Critical')
      .map((v) => v.affectedJobId);
    expect(violationJobIds.sort()).toEqual(['J2', 'J3']);

    // J1 ended up Scheduled; J2 and J3 are marked ConstraintViolation in the job schedules.
    const byJob = new Map(schedule.jobSchedules.map((j) => [j.jobId, j]));
    expect(byJob.get('J1')!.status).toBe('Scheduled');
    expect(byJob.get('J2')!.status).toBe('ConstraintViolation');
    expect(byJob.get('J3')!.status).toBe('ConstraintViolation');
  });
});

// ---------------------------------------------------------------------------
// Request marshalling
// ---------------------------------------------------------------------------

describe('CpSatSchedulingEngine — request marshalling', () => {
  it('includes every job, operation, and resource in the payload', async () => {
    const fetchSpy = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });
    (global as any).fetch = fetchSpy;

    const ctx = makeContext(
      [makeJob('J1', new Date('2026-05-20')), makeJob('J2', new Date('2026-05-21'))],
      [makeResource('R-A1', 'WC-A'), makeResource('R-A2', 'WC-A')]
    );

    const engine = new CpSatSchedulingEngine();
    await engine.schedule(ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.jobs).toHaveLength(2);
    expect(body.operations).toHaveLength(2);
    expect(body.resources).toHaveLength(2);
    expect(body.horizon_start_epoch).toBeLessThan(body.horizon_end_epoch);
    expect(body.time_limit_seconds).toBe(30); // default
  });

  it('sets line_group_id on resources when provided', async () => {
    const fetchSpy = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });
    (global as any).fetch = fetchSpy;

    const r1: Resource = { ...makeResource('R-A1', 'WC-A'), lineGroupId: 'LINE-1' };
    const r2: Resource = { ...makeResource('R-A2', 'WC-A') }; // no lineGroupId

    const ctx = makeContext([makeJob('J1', new Date('2026-05-20'))], [r1, r2]);
    const engine = new CpSatSchedulingEngine();
    await engine.schedule(ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const byId = new Map<string, any>(body.resources.map((r: any) => [r.resource_id, r]));
    expect(byId.get('R-A1').line_group_id).toBe('LINE-1');
    expect(byId.get('R-A2').line_group_id).toBeNull();
  });

  it('sets line_group_id on jobs when productionMode is flow-line', async () => {
    const fetchSpy = makeFetchOk({
      status: 'OPTIMAL',
      objective_value: 0,
      tardiness_score: 0,
      makespan_minutes: 0,
      changeover_minutes: 0,
      scheduled_operations: [],
      unscheduled_job_ids: [],
      solve_time_seconds: 0.01,
      solver_status_code: 4,
    });
    (global as any).fetch = fetchSpy;

    const job: Job = { ...makeJob('J1', new Date('2026-05-20')), lineGroupId: 'LINE-1' } as any;
    const ctx = makeContext([job], [makeResource('R-A1', 'WC-A')]);
    ctx.productionMode = 'flow-line';

    const engine = new CpSatSchedulingEngine();
    await engine.schedule(ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.jobs[0].line_group_id).toBe('LINE-1');
  });
});
