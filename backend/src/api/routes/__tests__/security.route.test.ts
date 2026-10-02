/**
 * Security regression tests (phase 1, 2026-09-29):
 *   - /api/status/databases and /connect are gated (first-run localhost only, else admin)
 *   - company_admin can't see/manage other companies' users or hand out admin roles
 *   - read-only roles can't change plans
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../../app';
import { JWT_SECRET } from '../../../config/secrets';

function token(role: string, companyId: number | null = 1, sub = 42): string {
  return jwt.sign({ sub, username: 'tester', role, companyId }, JWT_SECRET, { expiresIn: '1h' });
}

/** A lic_users row as the DB would return it. */
function userRow(id: number, companyId: number | null, role: string) {
  return {
    id, company_id: companyId, company_name: `Co${companyId}`, username: `u${id}`, email: `u${id}@x.com`,
    role, full_name: null, is_active: 1, last_login: null, created_at: new Date().toISOString(),
  };
}

/** Fake scheduler DB whose user lookups return `row`. */
function fakeSchedulerDb(row: any) {
  return {
    query: jest.fn().mockResolvedValue({ recordset: [] }),
    queryWithParams: jest.fn().mockImplementation(async (sql: string) =>
      /FROM\s+dbo\.lic_users u/i.test(sql) ? { recordset: row ? [row] : [] } : { recordset: [] }
    ),
    execute: jest.fn().mockResolvedValue({ recordset: [] }),
  };
}

afterEach(() => {
  app.locals.sysproDb = undefined;
  app.locals.schedulerDb = undefined;
});

describe('/api/status setup routes', () => {
  it('once connected, rejects /connect without a login', async () => {
    app.locals.sysproDb = {} as any;
    app.locals.schedulerDb = {} as any;
    const res = await request(app).post('/api/status/connect').send({ server: 'x', database: 'y' });
    expect(res.status).toBe(401);
  });

  it('once connected, rejects /databases for a planner', async () => {
    app.locals.sysproDb = {} as any;
    app.locals.schedulerDb = {} as any;
    const res = await request(app)
      .post('/api/status/databases')
      .set('Authorization', `Bearer ${token('planner')}`)
      .send({ server: 'x' });
    expect(res.status).toBe(403);
  });

  it('on first run, lets a local request through to validation', async () => {
    // supertest connects from 127.0.0.1; an empty body fails zod validation (400), proving the gate let it in.
    const res = await request(app).post('/api/status/connect').send({});
    expect(res.status).toBe(400);
  });
});

describe('/api/users company scoping', () => {
  it('company_admin gets 404 for a user in another company', async () => {
    app.locals.schedulerDb = fakeSchedulerDb(userRow(7, 2, 'planner')) as any;
    const res = await request(app).get('/api/users/7').set('Authorization', `Bearer ${token('company_admin', 1)}`);
    expect(res.status).toBe(404);
  });

  it('company_admin cannot delete a user in another company', async () => {
    const db = fakeSchedulerDb(userRow(7, 2, 'planner'));
    app.locals.schedulerDb = db as any;
    const res = await request(app).delete('/api/users/7').set('Authorization', `Bearer ${token('company_admin', 1)}`);
    expect(res.status).toBe(404);
    expect(db.queryWithParams.mock.calls.some(([sql]) => /DELETE FROM dbo\.lic_users/i.test(sql))).toBe(false);
  });

  it('company_admin cannot promote a user to super_admin', async () => {
    app.locals.schedulerDb = fakeSchedulerDb(userRow(7, 1, 'planner')) as any;
    const res = await request(app)
      .put('/api/users/7')
      .set('Authorization', `Bearer ${token('company_admin', 1)}`)
      .send({ role: 'super_admin' });
    expect(res.status).toBe(403);
  });

  it('company_admin cannot create a super_admin', async () => {
    app.locals.schedulerDb = fakeSchedulerDb(null) as any;
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${token('company_admin', 1)}`)
      .send({ username: 'evil', email: 'evil@x.com', password: 'longenough1', role: 'super_admin' });
    expect(res.status).toBe(403);
  });

  it('super_admin can read a user in any company', async () => {
    app.locals.schedulerDb = fakeSchedulerDb(userRow(7, 2, 'planner')) as any;
    const res = await request(app).get('/api/users/7').set('Authorization', `Bearer ${token('super_admin', null)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
  });
});

describe('read-only roles cannot change plans', () => {
  const viewer = () => `Bearer ${token('viewer')}`;
  it.each([
    ['post', '/api/schedule/save'],
    ['post', '/api/schedule/pin'],
    ['post', '/api/schedule/setup-matrix'],
    ['post', '/api/schedule/abc/approve-override'],
    ['post', '/api/schedule/abc/export-to-syspro'],
    ['post', '/api/resources/shifts'],
    ['post', '/api/jobs/bulk-import'],
    ['post', '/api/scenarios'],
  ])('%s %s → 403', async (method, url) => {
    const res = await (request(app) as any)[method](url).set('Authorization', viewer()).send({});
    expect(res.status).toBe(403);
  });
});

describe('/api/jobs/flags (exclude / pin job)', () => {
  afterEach(() => { delete (app.locals as any).jobFlags; });

  it('a planner sets and clears flags; they are stored for every run', async () => {
    const t = token('planner');
    let res = await request(app).put('/api/jobs/flags/J1').set('Authorization', `Bearer ${t}`).send({ excluded: true });
    expect(res.status).toBe(200);
    res = await request(app).put('/api/jobs/flags/J2').set('Authorization', `Bearer ${t}`).send({ pinned: true });
    expect(res.body).toEqual({ excluded: ['J1'], pinned: ['J2'] });
    expect((app.locals as any).jobFlags).toEqual({ excluded: ['J1'], pinned: ['J2'] });
    res = await request(app).put('/api/jobs/flags/J1').set('Authorization', `Bearer ${t}`).send({ excluded: false });
    expect(res.body).toEqual({ excluded: [], pinned: ['J2'] });
    res = await request(app).get('/api/jobs/flags').set('Authorization', `Bearer ${token('viewer')}`);
    expect(res.body).toEqual({ excluded: [], pinned: ['J2'] });
  });

  it('a viewer cannot change them', async () => {
    const res = await request(app).put('/api/jobs/flags/J1').set('Authorization', `Bearer ${token('viewer')}`).send({ excluded: true });
    expect(res.status).toBe(403);
  });
});
