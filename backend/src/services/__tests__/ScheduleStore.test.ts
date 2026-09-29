import { saveAsLatest, promoteToLatest } from '../ScheduleStore';

/** Fake DB that records every statement and whether it ran inside withTransaction. */
function fakeDb(existing = true) {
  const calls: Array<{ sql: string; params?: any; inTx: boolean }> = [];
  let inTx = false;
  const exec = {
    query: jest.fn(async (sql: string) => { calls.push({ sql, inTx }); return { recordset: [] }; }),
    queryWithParams: jest.fn(async (sql: string, params: any) => {
      calls.push({ sql, params, inTx });
      return { recordset: /SELECT 1 AS ok/.test(sql) && existing ? [{ ok: 1 }] : [] };
    }),
    execute: jest.fn(),
  };
  const db: any = {
    ...exec,
    withTransaction: jest.fn(async (cb: any) => { inTx = true; try { return await cb(exec); } finally { inTx = false; } }),
  };
  return { db, calls };
}

const schedule = {
  scheduleId: 'S1',
  status: 'Approved',
  planningHorizon: { startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-08T00:00:00Z' },
  jobSchedules: [{ jobId: 'J1', operationSchedules: [{}, {}] }, { jobId: 'J2', operationSchedules: [{}] }],
};

describe('ScheduleStore.saveAsLatest', () => {
  it('demotes, deletes and inserts inside ONE transaction, in that order', async () => {
    const { db, calls } = fakeDb();
    await saveAsLatest(db, schedule, { status: 'Draft' });
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(calls.every((c) => c.inTx)).toBe(true);
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(['UPDATE', 'DELETE', 'INSERT']);
  });

  it('stores the requested status and correct counts', async () => {
    const { db, calls } = fakeDb();
    const r = await saveAsLatest(db, schedule, { status: 'Draft' });
    const insert = calls.find((c) => /INSERT INTO aps\.SavedSchedules/.test(c.sql))!;
    expect(insert.params.status).toBe('Draft');
    expect(r).toEqual({ scheduleId: 'S1', jobCount: 2, operationCount: 3 });
  });
});

describe('ScheduleStore.promoteToLatest', () => {
  it('returns false and changes nothing when the schedule does not exist', async () => {
    const { db, calls } = fakeDb(false);
    expect(await promoteToLatest(db, 'NOPE')).toBe(false);
    expect(calls.some((c) => /IsLatest = 0/.test(c.sql))).toBe(false);
  });

  it('demotes all and promotes the one, inside a transaction', async () => {
    const { db, calls } = fakeDb(true);
    expect(await promoteToLatest(db, 'S1')).toBe(true);
    expect(calls.every((c) => c.inTx)).toBe(true);
    expect(calls.some((c) => /SET IsLatest = 1 WHERE ScheduleID/.test(c.sql))).toBe(true);
  });
});
