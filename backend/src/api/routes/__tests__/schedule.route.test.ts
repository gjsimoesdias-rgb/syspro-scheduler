/**
 * Integration tests for /api/schedule routes.
 *
 * We mount the full Express app in-process (via supertest) and inject a fake
 * sysproDb into app.locals so the routes can exercise their control flow
 * without a real SQL Server.
 *
 * Note: POST /generate is tested only up to the DB/auth guard — we stop
 * before the Worker thread so we don't need to mock worker_threads (which
 * would break pino's thread-stream).
 *
 * Covers:
 *   - Auth guard: 401 without token, 401 with bad token
 *   - POST /generate: 503 when DB absent, 400 for invalid body
 *   - POST /:id/approve: 403 wrong role, 503 DB absent, 404 not found, 200 happy path
 *   - GET  /latest: 503 DB absent, 200 with schedule, 200 with null when empty
 *   - POST /save: 400 missing schedule.scheduleId, 200 happy path
 */

// Plan tables now live in the SCHEDULER DB (services/planStore.ts). In these
// tests the plan store is the same fake DB the route sees as sysproDb.
jest.mock('../../../services/planStore', () => ({
  planDbFor: jest.fn(async (appArg: any) => {
    const db = appArg.locals.sysproDb;
    if (!db) throw Object.assign(new Error('Database not connected'), { status: 503 });
    return db;
  }),
}));

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../../app';
import { JWT_SECRET } from '../../../config/secrets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(role = 'Viewer', sub = 42): string {
  return jwt.sign({ sub, username: 'testuser', role, companyId: 1 }, JWT_SECRET, { expiresIn: '1h' });
}

/** Minimal fake sysproDb that lets routes succeed */
function makeFakeDb(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const db: Record<string, jest.Mock> = {
    query: jest.fn().mockResolvedValue({ recordset: [] }),
    queryWithParams: jest.fn().mockResolvedValue({ recordset: [] }),
    execute: jest.fn().mockResolvedValue({ recordset: [] }),
    withTransaction: jest.fn().mockImplementation(async (cb: (d: any) => Promise<any>) => cb(db)),
    ...overrides,
  };
  return db;
}

// ---------------------------------------------------------------------------
// Auth guard (applies to all /api/schedule routes)
// ---------------------------------------------------------------------------

describe('auth guard — /api/schedule', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await request(app).post('/api/schedule/generate').send({});
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 when token is invalid/expired', async () => {
    const res = await request(app)
      .post('/api/schedule/generate')
      .set('Authorization', 'Bearer not.a.valid.token')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule/generate
// ---------------------------------------------------------------------------

describe('POST /api/schedule/generate', () => {
  const token = makeToken('planner');

  it('returns 403 for a read-only (viewer) role', async () => {
    const res = await request(app)
      .post('/api/schedule/generate')
      .set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  beforeEach(() => {
    // Remove any previously set sysproDb so each test starts clean
    delete (app.locals as any).sysproDb;
  });

  it('returns 503 when sysproDb is not set in app.locals', async () => {
    const res = await request(app)
      .post('/api/schedule/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not connected/i);
  });

  it('returns 400 for an invalid schedulingDirection value', async () => {
    const res = await request(app)
      .post('/api/schedule/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ schedulingDirection: 'sideways' });   // not 'forward' | 'backward'
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule/:scheduleId/approve
// ---------------------------------------------------------------------------

describe('POST /api/schedule/:scheduleId/approve', () => {
  const scheduleId = 'sched-abc-123';

  afterEach(() => {
    delete (app.locals as any).sysproDb;
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).post(`/api/schedule/${scheduleId}/approve`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller lacks planner/admin role', async () => {
    // 'Viewer' is not in the allowed roles for approve: planner, company_admin, super_admin
    const viewerToken = makeToken('Viewer');
    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permissions/i);
  });

  it('returns 503 when DB not connected (planner role)', async () => {
    // Route allows: planner, company_admin, super_admin
    const plannerToken = makeToken('planner');
    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${plannerToken}`);
    expect(res.status).toBe(503);
  });

  it('returns 404 when schedule does not exist in DB', async () => {
    const plannerToken = makeToken('planner');
    (app.locals as any).sysproDb = makeFakeDb({
      queryWithParams: jest.fn().mockResolvedValue({ recordset: [] }),  // empty → not found
    });

    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${plannerToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 200 with Approved status for planner role', async () => {
    const plannerToken = makeToken('planner');
    (app.locals as any).sysproDb = makeFakeDb({
      queryWithParams: jest.fn()
        .mockResolvedValueOnce({ recordset: [{ IsLatest: true, VersionKind: 'Plan' }] }) // master check
        .mockResolvedValueOnce({ recordset: [] }),  // UPDATE
    });

    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${plannerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scheduleId, status: 'Approved' });
  });

  it('returns 200 with super_admin role', async () => {
    const adminToken = makeToken('super_admin');
    (app.locals as any).sysproDb = makeFakeDb({
      queryWithParams: jest.fn()
        .mockResolvedValueOnce({ recordset: [{ IsLatest: true, VersionKind: 'Plan' }] })
        .mockResolvedValueOnce({ recordset: [] }),
    });

    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it.each([
    ['a what-if', { IsLatest: false, VersionKind: 'WhatIf' }, /what-if/],
    ['a history version', { IsLatest: false, VersionKind: 'Plan' }, /not the master/],
  ])('refuses to approve %s (409)', async (_label, row, msg) => {
    const qwp = jest.fn().mockResolvedValue({ recordset: [row] });
    (app.locals as any).sysproDb = makeFakeDb({ queryWithParams: qwp });
    const res = await request(app)
      .post(`/api/schedule/${scheduleId}/approve`)
      .set('Authorization', `Bearer ${makeToken('planner')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(msg);
    expect(qwp.mock.calls.some(([sql]) => /SET Status = 'Approved'/.test(sql))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/schedule/latest
// ---------------------------------------------------------------------------

describe('GET /api/schedule/latest', () => {
  const token = makeToken('Viewer');

  afterEach(() => {
    delete (app.locals as any).sysproDb;
  });

  it('returns 503 when DB not connected', async () => {
    const res = await request(app)
      .get('/api/schedule/latest')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
  });

  it('returns { schedule: null } when no saved schedules exist', async () => {
    (app.locals as any).sysproDb = makeFakeDb({
      query: jest.fn().mockResolvedValue({ recordset: [] }),
    });

    const res = await request(app)
      .get('/api/schedule/latest')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schedule: null });
  });

  it('returns the parsed schedule when one exists', async () => {
    const fakeSchedule = { scheduleId: 'sched-999', jobSchedules: [], constraintViolations: [] };
    (app.locals as any).sysproDb = makeFakeDb({
      query: jest.fn().mockResolvedValue({
        recordset: [{
          ScheduleID: 'sched-999',
          ScheduleData: JSON.stringify(fakeSchedule),
          Status: 'Draft',
          JobCount: 0,
          OperationCount: 0,
          HorizonStart: null,
          HorizonEnd: null,
          GeneratedAt: new Date().toISOString(),
          SavedAt: new Date().toISOString(),
        }],
      }),
    });

    const res = await request(app)
      .get('/api/schedule/latest')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({ scheduleId: 'sched-999' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule/save
// ---------------------------------------------------------------------------

describe('POST /api/schedule/save', () => {
  const token = makeToken('planner');

  afterEach(() => {
    delete (app.locals as any).sysproDb;
  });

  it('returns 400 when schedule.scheduleId is missing', async () => {
    (app.locals as any).sysproDb = makeFakeDb();
    const res = await request(app)
      .post('/api/schedule/save')
      .set('Authorization', `Bearer ${token}`)
      .send({ schedule: { jobSchedules: [] } });  // no scheduleId
    expect(res.status).toBe(400);
  });

  it('returns 200 and saved: true on valid save', async () => {
    (app.locals as any).sysproDb = makeFakeDb();
    const res = await request(app)
      .post('/api/schedule/save')
      .set('Authorization', `Bearer ${token}`)
      .send({ schedule: { scheduleId: 'save-test-1', jobSchedules: [] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ saved: true, scheduleId: 'save-test-1' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/schedule/:scheduleId/export-to-syspro
// ---------------------------------------------------------------------------

describe('POST /api/schedule/:scheduleId/export-to-syspro', () => {
  const token = makeToken('planner');
  afterEach(() => { app.locals.sysproDb = undefined; });

  it('returns 404 when the schedule was never saved', async () => {
    app.locals.sysproDb = makeFakeDb() as any;
    const res = await request(app)
      .post('/api/schedule/S1/export-to-syspro')
      .set('Authorization', `Bearer ${token}`)
      .send({ schedule: { scheduleId: 'S1', jobSchedules: [] } });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the saved schedule is not Approved', async () => {
    app.locals.sysproDb = makeFakeDb({
      queryWithParams: jest.fn().mockResolvedValue({
        recordset: [{ ScheduleData: JSON.stringify({ scheduleId: 'S1', jobSchedules: [] }), Status: 'Draft', IsLatest: true, VersionKind: 'Plan' }],
      }),
    }) as any;
    const res = await request(app)
      .post('/api/schedule/S1/export-to-syspro')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(409);
  });

  it('exports the SAVED schedule (not the request body) and marks it Exported', async () => {
    const qwp = jest.fn().mockImplementation(async (sql: string) =>
      /SELECT IsLatest, VersionKind/.test(sql) ? { recordset: [{ IsLatest: true, VersionKind: 'Plan' }] }
      : /SELECT ScheduleData, Status/.test(sql)
        ? { recordset: [{ ScheduleData: JSON.stringify({ scheduleId: 'S1', jobSchedules: [] }), Status: 'Approved' }] }
        : { recordset: [] }
    );
    app.locals.sysproDb = makeFakeDb({ queryWithParams: qwp }) as any;
    const res = await request(app)
      .post('/api/schedule/S1/export-to-syspro')
      .set('Authorization', `Bearer ${token}`)
      .send({ schedule: { scheduleId: 'S1', jobSchedules: [{ jobId: 'INJECTED', operationSchedules: [] }] } });
    expect(res.status).toBe(200);
    expect(qwp.mock.calls.some(([sql]) => /SET Status = 'Exported'/.test(sql))).toBe(true);
    expect(JSON.stringify(qwp.mock.calls)).not.toContain('INJECTED');
  });
});

describe('export-to-syspro — incremental publish', () => {
  const token = makeToken('planner');
  afterEach(() => { app.locals.sysproDb = undefined; });
  const op = (jobId: string, start: string) => ({ opId: `${jobId}-OP10`, resourceId: 'M1', plannedStartDate: start, plannedEndDate: '2026-10-02T16:00:00Z' });
  const jobA = { jobId: 'A', plannedStartDate: '2026-10-01T08:00:00Z', plannedEndDate: '2026-10-02T16:00:00Z', operationSchedules: [op('A', '2026-10-01T08:00:00Z')] };

  it('skips SYSPRO entirely when every job matches the last send', async () => {
    const { jobFingerprint } = await import('../../../services/publishStatus');
    const qwp = jest.fn().mockImplementation(async (sql: string) =>
      /SELECT IsLatest, VersionKind/.test(sql) ? { recordset: [{ IsLatest: true, VersionKind: 'Plan' }] }
      : /SELECT ScheduleData, Status/.test(sql)
        ? { recordset: [{ ScheduleData: JSON.stringify({ scheduleId: 'S1', jobSchedules: [jobA] }), Status: 'Approved' }] }
        : { recordset: [] });
    const query = jest.fn().mockImplementation(async (sql: string) =>
      /aps\.JobPublishStatus/.test(sql)
        ? { recordset: [{ JobId: 'A', Status: 'Published', Fingerprint: jobFingerprint(jobA) }] }
        : { recordset: [] });
    const db = makeFakeDb({ queryWithParams: qwp, query });
    app.locals.sysproDb = db as any;
    const res = await request(app).post('/api/schedule/S1/export-to-syspro').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Nothing changed/);
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(qwp.mock.calls.some(([sql]) => /SET Status = 'Exported'/.test(sql))).toBe(true);
  });
});

describe('locks — time fence and remove all', () => {
  const token = makeToken('planner');
  afterEach(() => { app.locals.sysproDb = undefined; (app.locals as any).pinnedOperations = undefined; });

  it('locks master ops starting before the fence, then removes them', async () => {
    const op = (id: string, start: string) => ({ opId: id, workcentreId: 'L1', resourceId: 'R1', plannedStartDate: start, plannedEndDate: start });
    const master = { jobSchedules: [{ jobId: 'J1', operationSchedules: [op('J1-OP10', '2026-10-01T08:00:00Z'), op('J1-OP20', '2026-10-09T08:00:00Z')] }] };
    app.locals.sysproDb = makeFakeDb({ query: jest.fn().mockResolvedValue({ recordset: [{ ScheduleData: JSON.stringify(master) }] }) }) as any;
    const lock = await request(app).post('/api/schedule/pins/time-fence').set('Authorization', `Bearer ${token}`)
      .send({ until: '2026-10-05T00:00:00Z' });
    expect(lock.status).toBe(200);
    expect(lock.body).toMatchObject({ added: 1, total: 1 });
    expect(Object.keys((app.locals as any).pinnedOperations)).toEqual(['J1::J1-OP10']);

    const clear = await request(app).delete('/api/schedule/pins').set('Authorization', `Bearer ${token}`);
    expect(clear.body).toMatchObject({ removed: 1, total: 0 });
  });

  it('viewers cannot lock', async () => {
    const res = await request(app).post('/api/schedule/pins/time-fence').set('Authorization', `Bearer ${makeToken('viewer')}`)
      .send({ until: '2026-10-05T00:00:00Z' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/schedule/save — approval is never carried over', () => {
  it('stores the schedule as Draft even if the body says Approved', async () => {
    const qwp = jest.fn().mockResolvedValue({ recordset: [] });
    app.locals.sysproDb = makeFakeDb({ queryWithParams: qwp }) as any;
    const res = await request(app)
      .post('/api/schedule/save')
      .set('Authorization', `Bearer ${makeToken('planner')}`)
      .send({ schedule: { scheduleId: 'S9', status: 'Approved', jobSchedules: [] } });
    expect(res.status).toBe(200);
    const insert = qwp.mock.calls.find(([sql]) => /INSERT INTO aps\.SavedSchedules/.test(sql));
    expect(insert?.[1].status).toBe('Draft');
    app.locals.sysproDb = undefined;
  });
});

describe('export-to-syspro — master only, one at a time', () => {
  const token = makeToken('planner');
  afterEach(() => { app.locals.sysproDb = undefined; });

  it('refuses a what-if even when it is Approved', async () => {
    const qwp = jest.fn().mockImplementation(async (sql: string) =>
      /SELECT IsLatest, VersionKind/.test(sql) ? { recordset: [{ IsLatest: false, VersionKind: 'WhatIf' }] }
      : { recordset: [{ ScheduleData: '{"jobSchedules":[]}', Status: 'Approved' }] });
    app.locals.sysproDb = makeFakeDb({ queryWithParams: qwp }) as any;
    const res = await request(app).post('/api/schedule/W1/export-to-syspro').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/what-if/);
  });

  it('a second send while one is running gets 409, and the lock is released afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const qwp = jest.fn().mockImplementation(async (sql: string) => {
      if (/SELECT IsLatest, VersionKind/.test(sql)) return { recordset: [{ IsLatest: true, VersionKind: 'Plan' }] };
      if (/SELECT ScheduleData, Status/.test(sql)) {
        await gate;
        return { recordset: [{ ScheduleData: JSON.stringify({ scheduleId: 'S1', jobSchedules: [] }), Status: 'Approved' }] };
      }
      return { recordset: [] };
    });
    app.locals.sysproDb = makeFakeDb({ queryWithParams: qwp }) as any;
    const first = request(app).post('/api/schedule/S1/export-to-syspro').set('Authorization', `Bearer ${token}`).send({}).then((r) => r);
    // let the first request reach the gate
    await new Promise((r) => setTimeout(r, 50));
    const second = await request(app).post('/api/schedule/S1/export-to-syspro').set('Authorization', `Bearer ${token}`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/);
    release();
    expect((await first).status).toBe(200);
    const third = await request(app).post('/api/schedule/S1/export-to-syspro').set('Authorization', `Bearer ${token}`).send({});
    expect(third.status).toBe(200);
  });
});
