import { rewritePlanSql, planSchemaFor, companyDbOf, PlanDb, ensurePlanStore, planDbFor, __resetPlanStoreCache } from '../planStore';

describe('planStore SQL rewrite', () => {
  it('points aps plan tables (incl. OBJECT_ID strings and constraint names) at the company schema', () => {
    const s = planSchemaFor('HFARMCompany1');
    expect(s).toBe('co_HFARMCompany1');
    expect(planSchemaFor('Bad-Name;DROP')).toBe('co_Bad_Name_DROP');
    const out = rewritePlanSql(
      "IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT 1; ELSE SELECT * FROM aps.SavedSchedules s JOIN aps.JobPublishStatus p ON 1=1 -- PK_aps_SavedSchedules",
      s);
    expect(out).toBe("IF OBJECT_ID('co_HFARMCompany1.SavedSchedules', 'U') IS NULL SELECT 1; ELSE SELECT * FROM [co_HFARMCompany1].SavedSchedules s JOIN [co_HFARMCompany1].JobPublishStatus p ON 1=1 -- PK_SavedSchedules");
    // LYNQ compat objects in the SYSPRO aps schema are not touched
    expect(rewritePlanSql('SELECT * FROM aps.VP_SourceProductionOrdersView', s)).toBe('SELECT * FROM aps.VP_SourceProductionOrdersView');
  });
  it('reads the company DB from the connection config', () => {
    expect(companyDbOf({ config: { database: 'HFARMCompany1' } })).toBe('HFARMCompany1');
    expect(companyDbOf(null)).toBe('default');
  });
});

const fakeScheduler = () => {
  const calls: string[] = [];
  const rows: Record<string, any[]> = {};
  const exec = {
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      const m = /SELECT COUNT\(\*\) AS n FROM \[co_X\]\.(\w+)/.exec(sql);
      if (m) return { recordset: [{ n: (rows[m[1]] || []).length }] };
      return { recordset: [] };
    }),
    queryWithParams: jest.fn(async (sql: string, p: any) => {
      calls.push(sql);
      const m = /INSERT INTO \[co_X\]\.(\w+)/.exec(sql);
      if (m) (rows[m[1]] ||= []).push(p);
      return { recordset: [] };
    }),
    execute: jest.fn(),
  };
  return { calls, rows, db: { ...exec, withTransaction: jest.fn(async (cb: any) => cb(exec)) } };
};

describe('ensurePlanStore', () => {
  it('creates schema + tables and copies legacy SYSPRO rows once', async () => {
    const sch = fakeScheduler();
    const syspro = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('aps.SavedSchedules')) return { recordset: [{ ScheduleID: 'm1', ScheduleData: '{}', Status: 'Draft', IsLatest: true, Extra: 1 }] };
        if (sql.includes('aps.JobPublishStatus')) return { recordset: [{ JobId: 'J1', Status: 'Published' }] };
        return { recordset: [] };
      }),
    };
    const plan = new PlanDb(sch.db as any, 'co_X', 'X');
    const r1 = await ensurePlanStore(plan, syspro);
    expect(sch.calls[0]).toContain("CREATE SCHEMA [co_X]");
    expect(sch.calls.some((c) => c.includes('CREATE TABLE [co_X].SavedSchedules'))).toBe(true);
    expect(r1.copied).toEqual({ SavedSchedules: 1, JobPublishStatus: 1 });
    expect(sch.rows.SavedSchedules[0]).toEqual({ ScheduleID: 'm1', ScheduleData: '{}', Status: 'Draft', IsLatest: true });
    // second run: target not empty → nothing copied again
    const r2 = await ensurePlanStore(plan, syspro);
    expect(r2.copied).toEqual({});
  });

  it('planDbFor needs the SCHEDULER DB and provisions once per company', async () => {
    __resetPlanStoreCache();
    await expect(planDbFor({ locals: {} })).rejects.toThrow('Scheduler database not connected');
    const sch = fakeScheduler();
    const app = { locals: { schedulerDb: sch.db, sysproDb: { config: { database: 'X' }, query: jest.fn(async () => ({ recordset: [] })) } } };
    const a = await planDbFor(app);
    const b = await planDbFor(app);
    expect(a).toBe(b);
    expect(a.schema).toBe('co_X');
    expect(sch.calls.filter((c) => c.includes('CREATE SCHEMA')).length).toBe(1);
  });

  it('after a SCHEDULER reconnect, every company gets a store on the new connection (never the closed one)', async () => {
    __resetPlanStoreCache();
    const syspro = (db: string) => ({ config: { database: db }, query: jest.fn(async () => ({ recordset: [] })) });
    const oldConn = fakeScheduler();
    const app: any = { locals: { schedulerDb: oldConn.db, sysproDb: syspro('A') } };
    const aOld = await planDbFor(app);
    app.locals.sysproDb = syspro('B');
    await planDbFor(app);

    const newConn = fakeScheduler();
    app.locals.schedulerDb = newConn.db;
    app.locals.sysproDb = syspro('B');
    await planDbFor(app);
    app.locals.sysproDb = syspro('A');               // back to a company cached on the old connection
    const aNew = await planDbFor(app);
    expect(aNew).not.toBe(aOld);
    await aNew.query('SELECT 1 FROM aps.SavedSchedules');
    expect(newConn.calls.some((c) => c.includes('[co_A].SavedSchedules'))).toBe(true);
  });
});
