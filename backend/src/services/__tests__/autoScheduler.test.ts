// Rows the "find the current Auto plan what-if" query returns.
const autoRows: { list: Array<{ ScheduleID: string }> } = { list: [] };
jest.mock('../planStore', () => ({
  planDbFor: jest.fn(async () => ({ schema: 'co_test', queryWithParams: jest.fn(async () => ({ recordset: autoRows.list })) })),
}));
jest.mock('../ScheduleStore', () => ({
  getVersion: jest.fn(async () => null),
  createWhatIf: jest.fn(async () => ({ versionId: 'whatif-auto-plan' })),
}));
jest.mock('../SysproDatabaseService', () => {
  const jobs = { list: [{ jobId: 'J1', quantity: 5, dueDate: '2026-10-10', status: 'Released', operations: [] }] };
  const Cls = jest.fn().mockImplementation(() => ({ getOpenJobs: jest.fn(async () => jobs.list) }));
  (Cls as any).__jobs = jobs;
  return { __esModule: true, default: Cls, SysproDatabaseService: Cls };
});

import { AutoScheduler, decideAutoRun, normaliseAutoConfig, jobsFingerprint, AUTO_PLAN_VERSION_ID, autoPlanVersionId } from '../autoScheduler';
import { createWhatIf, getVersion } from '../ScheduleStore';
import SysproDatabaseService from '../SysproDatabaseService';

const now = new Date('2026-10-01T10:00:00Z');
const minsAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();
const on = normaliseAutoConfig({ enabled: true, intervalMinutes: 60, onJobChange: true, checkMinutes: 5 });

describe('decideAutoRun', () => {
  it('waits when off or already running', () => {
    expect(decideAutoRun({ ...on, enabled: false }, { running: false }, now).action).toBe('wait');
    expect(decideAutoRun(on, { running: true }, now).action).toBe('wait');
  });
  it('runs first, then on the interval, and checks for changes in between', () => {
    expect(decideAutoRun(on, { running: false }, now)).toEqual({ action: 'run', reason: 'first run' });
    expect(decideAutoRun(on, { running: false, lastRunAt: minsAgo(61) }, now).action).toBe('run');
    expect(decideAutoRun(on, { running: false, lastRunAt: minsAgo(10), lastCheckAt: minsAgo(6) }, now).action).toBe('check');
    expect(decideAutoRun(on, { running: false, lastRunAt: minsAgo(10), lastCheckAt: minsAgo(2) }, now).action).toBe('wait');
    expect(decideAutoRun({ ...on, intervalMinutes: 0 }, { running: false, lastRunAt: minsAgo(600), lastCheckAt: minsAgo(1) }, now).action).toBe('wait');
  });
});

describe('normaliseAutoConfig / jobsFingerprint', () => {
  it('clamps numbers and keeps previous values', () => {
    const c = normaliseAutoConfig({ intervalMinutes: 99999, checkMinutes: 0 }, on);
    expect(c).toMatchObject({ enabled: true, intervalMinutes: 1440, checkMinutes: 1, onJobChange: true });
  });
  it('changes when a job changes, not when order changes', () => {
    const a = [{ jobId: 'A', quantity: 1, dueDate: '2026-10-01', operations: [] }, { jobId: 'B', quantity: 2, dueDate: '2026-10-02', operations: [] }];
    expect(jobsFingerprint(a)).toBe(jobsFingerprint([a[1], a[0]]));
    expect(jobsFingerprint(a)).not.toBe(jobsFingerprint([a[0], { ...a[1], quantity: 3 }]));
  });
});

describe('AutoScheduler.runNow', () => {
  const app = () => ({ locals: { sysproDb: {}, autoSchedule: { ...on, companyId: 7 }, lastGenerateOptions: { schedulingRule: 'edd', horizonDays: 10, freezeHorizonDays: 2 } } });

  it('creates the Auto plan what-if and generates into it with the last options from now', async () => {
    const generate = jest.fn(async (req: any, res: any) => res.json({ schedule: { jobSchedules: [{ operationSchedules: [{}] }], metrics: { totalJobsScheduled: 1, jobsUnscheduled: 0, jobsTardy: 1 } } }));
    const a = new AutoScheduler(app() as any, generate);
    const st = await a.runNow('test');
    expect(createWhatIf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ newId: AUTO_PLAN_VERSION_ID, name: 'Auto plan' }));
    const req = generate.mock.calls[0][0];
    expect(req.body).toMatchObject({ schedulingRule: 'edd', freezeHorizonDays: 2, versionId: AUTO_PLAN_VERSION_ID });
    expect(req.body.horizonDays).toBeUndefined();
    expect(Date.parse(req.body.planningHorizonEndDate) - Date.parse(req.body.planningHorizonStartDate)).toBe(10 * 86400000);
    expect(req.user).toMatchObject({ companyId: 7, username: 'auto-schedule' });
    expect(st.lastResult).toMatchObject({ ok: true, scheduled: 1, late: 1 });
    expect(st.lastFingerprint).toBeTruthy();
    expect(st.running).toBe(false);
  });

  it('records a failed generate', async () => {
    const generate = jest.fn(async (_req: any, res: any) => res.status(500).json({ error: 'boom' }));
    const st = await new AutoScheduler(app() as any, generate).runNow('test');
    expect(st.lastResult).toMatchObject({ ok: false, error: 'boom' });
  });

  it('a change check re-plans only when SYSPRO jobs changed', async () => {
    const generate = jest.fn(async (_req: any, res: any) => res.json({ schedule: { jobSchedules: [], metrics: {} } }));
    const a = new AutoScheduler(app() as any, generate);
    await a.runNow('first');
    a.status.lastCheckAt = minsAgo(10);
    a.status.lastRunAt = new Date(now.getTime() - 10 * 60000).toISOString();
    await a.tick(now);
    expect(generate).toHaveBeenCalledTimes(1);
    (SysproDatabaseService as any).__jobs.list = [{ jobId: 'J1', quantity: 6, dueDate: '2026-10-10', status: 'Released', operations: [] }];
    a.status.lastCheckAt = minsAgo(10);
    await a.tick(now);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(a.status.lastReason).toBe('SYSPRO jobs changed');
  });
});

describe('autoPlanVersionId', () => {
  const plan = () => ({ queryWithParams: jest.fn(async () => ({ recordset: autoRows.list })) });
  beforeEach(() => { autoRows.list = []; (createWhatIf as jest.Mock).mockClear(); (getVersion as jest.Mock).mockReset(); });

  it('reuses the open Auto plan what-if', async () => {
    autoRows.list = [{ ScheduleID: 'whatif-auto-plan' }];
    expect(await autoPlanVersionId(plan() as any)).toBe('whatif-auto-plan');
    expect(createWhatIf).not.toHaveBeenCalled();
  });

  it('creates the what-if under the usual id the first time', async () => {
    (getVersion as jest.Mock).mockResolvedValue(null);
    expect(await autoPlanVersionId(plan() as any)).toBe(AUTO_PLAN_VERSION_ID);
    expect(createWhatIf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ newId: AUTO_PLAN_VERSION_ID, createdBy: 'auto-schedule' }));
  });

  it('starts a new what-if once the Auto plan was committed (its id now belongs to a plan)', async () => {
    (getVersion as jest.Mock).mockResolvedValue({ summary: { kind: 'Master' } });
    const id = await autoPlanVersionId(plan() as any);
    expect(id).not.toBe(AUTO_PLAN_VERSION_ID);
    expect(id.startsWith(`${AUTO_PLAN_VERSION_ID}-`)).toBe(true);
    expect(createWhatIf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ newId: id }));
  });
});
