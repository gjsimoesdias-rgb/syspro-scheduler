/**
 * CP-SAT payload — master/sub-job hierarchy (PLAN_2026-07-07 §2.3).
 *
 * The solve request must carry each job's master_job_id so the Python
 * sidecar can enforce "sub-jobs finish before the master starts".
 * Hermetic: global fetch is stubbed, no sidecar needed.
 */

import { CpSatSchedulingEngine } from '../CpSatEngine';
import type { SchedulingContext } from '../SchedulingEngine';
import { Job, Resource, Workcentre } from '../../types';

function makeJob(jobId: string, extra: Partial<Job> = {}): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    quantity: 1,
    dueDate: new Date('2026-07-20T00:00:00Z'),
    releaseDate: new Date('2026-07-08T00:00:00Z'),
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
        setupTime: 0,
        queueTime: 0,
        moveTime: 0,
        batchSize: 1,
        qualifiedResourceIds: ['R-A1'],
        status: 'NotStarted',
      },
    ],
    ...extra,
  } as any;
}

function makeContext(jobs: Job[]): SchedulingContext {
  const resource: Resource = {
    resourceId: 'R-A1',
    name: 'R-A1',
    type: 'Machine',
    worcentreId: 'WC-A',
    skillTags: [],
    costPerHour: 50,
    calendar: { calendarId: 'c', name: 's', workingDays: [1, 2, 3, 4, 5], workingHoursPerDay: 8, shifts: [], holidays: [] },
    status: 'Available',
  } as Resource;
  const wc: Workcentre = {
    worcentreId: 'WC-A',
    name: 'WC-A',
    description: '',
    capabilities: [],
    shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 },
    calendar: { calendarId: 'c', name: 's', workingDays: [1, 2, 3, 4, 5], workingHoursPerDay: 8, shifts: [], holidays: [] },
    costPerHour: 80,
    maxOvertimePerDay: 0,
  } as Workcentre;

  return {
    jobs,
    workcentres: new Map([['WC-A', wc]]),
    resources: new Map([['R-A1', resource]]),
    materials: new Map(),
    planningHorizonStart: new Date('2026-07-08T00:00:00Z'),
    planningHorizonEnd: new Date('2026-07-31T00:00:00Z'),
  } as SchedulingContext;
}

type FetchArgs = [string, RequestInit];

const makeFetchOk = () =>
  jest.fn(async (..._args: FetchArgs) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        status: 'OPTIMAL',
        objective_value: 0,
        tardiness_score: 0,
        makespan_minutes: 0,
        changeover_minutes: 0,
        scheduled_operations: [],
        unscheduled_job_ids: [],
        solve_time_seconds: 0.1,
        solver_status_code: 4,
      };
    },
    async text() {
      return '{}';
    },
  }));

let originalFetch: typeof fetch | undefined;
beforeEach(() => {
  originalFetch = (global as any).fetch;
});
afterEach(() => {
  (global as any).fetch = originalFetch;
});

describe('CpSatSchedulingEngine — master_job_id in solve request', () => {
  it('sub-jobs carry their master id; standalone jobs carry null', async () => {
    const master = makeJob('MST-1', { isMasterJob: true });
    const sub = makeJob('SUB-1', { masterJobId: 'MST-1', isSubJob: true });
    const solo = makeJob('SOLO-1');

    const fetchMock = makeFetchOk();
    (global as any).fetch = fetchMock;

    const engine = new CpSatSchedulingEngine();
    await engine.schedule(makeContext([master, sub, solo]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

    const byId: Record<string, any> = {};
    for (const j of body.jobs) byId[j.job_id] = j;

    expect(byId['SUB-1'].master_job_id).toBe('MST-1');
    expect(byId['MST-1'].master_job_id).toBeNull();
    expect(byId['SOLO-1'].master_job_id).toBeNull();
  });
});
