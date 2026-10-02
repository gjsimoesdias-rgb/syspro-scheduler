import {
  listVersions, commitWhatIf, revertToVersion, deleteVersion, saveIntoWhatIf, createWhatIf, metricsSnapshot, VersionError,
} from '../ScheduleStore';

/** Fake DB: `rows` answers the SELECT for a single version; records every statement. */
function fakeDb(rows: Record<string, any> = {}) {
  const calls: Array<{ sql: string; params?: any; inTx: boolean }> = [];
  let inTx = false;
  const exec = {
    query: jest.fn(async (sql: string) => { calls.push({ sql, inTx }); return { recordset: rows.__list || [] }; }),
    queryWithParams: jest.fn(async (sql: string, params: any) => {
      calls.push({ sql, params, inTx });
      const id = params?.versionId ?? params?.fromId;
      if (/^\s*SELECT/i.test(sql) && id !== undefined) return { recordset: rows[id] ? [rows[id]] : [] };
      if (/SELECT TOP 1 ScheduleID, ScheduleData/.test(sql)) return { recordset: rows.__master ? [rows.__master] : [] };
      return { recordset: [] };
    }),
    execute: jest.fn(),
  };
  const db: any = { ...exec, withTransaction: jest.fn(async (cb: any) => { inTx = true; try { return await cb(exec); } finally { inTx = false; } }) };
  return { db, calls };
}

describe('plan versions', () => {
  it('lists master, what-ifs and history from one query', async () => {
    const { db } = fakeDb({ __list: [
      { ScheduleID: 'M', IsLatest: true, VersionKind: 'Plan', VersionName: 'Mon plan', Status: 'Approved', SavedAt: new Date(), MetricsJson: '{"otdRate":90}' },
      { ScheduleID: 'W', IsLatest: false, VersionKind: 'WhatIf', VersionName: 'Overtime Sat', Status: 'Draft', SavedAt: new Date() },
      { ScheduleID: 'H', IsLatest: false, VersionKind: 'Plan', VersionName: null, Status: 'Exported', SavedAt: new Date() },
    ] });
    const v = await listVersions(db);
    expect(v.master?.versionId).toBe('M');
    expect(v.master?.metrics).toEqual({ otdRate: 90 });
    expect(v.whatIfs.map((x) => x.versionId)).toEqual(['W']);
    expect(v.history.map((x) => [x.versionId, x.kind])).toEqual([['H', 'History']]);
  });

  it('commit: only a what-if; demotes the master and promotes it in one transaction, as Draft', async () => {
    const { db, calls } = fakeDb({ W: { VersionKind: 'WhatIf' }, H: { VersionKind: 'Plan' } });
    await expect(commitWhatIf(db, 'H')).rejects.toBeInstanceOf(VersionError);
    calls.length = 0;
    await commitWhatIf(db, 'W');
    expect(calls.every((c) => c.inTx)).toBe(true);
    expect(calls.some((c) => /SET IsLatest = 0 WHERE IsLatest = 1/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /SET IsLatest = 1, VersionKind = 'Plan', Status = 'Draft'/.test(c.sql))).toBe(true);
  });

  it('revert refuses what-ifs; delete refuses the master', async () => {
    const { db } = fakeDb({ W: { VersionKind: 'WhatIf', IsLatest: false }, M: { VersionKind: 'Plan', IsLatest: true } });
    await expect(revertToVersion(db, 'W')).rejects.toThrow('commit');
    await expect(deleteVersion(db, 'M')).rejects.toThrow('master plan cannot be deleted');
    await expect(deleteVersion(db, 'NOPE')).rejects.toMatchObject({ status: 404 });
  });

  it('saveIntoWhatIf refuses the master/history and stamps the version id into the schedule', async () => {
    const { db, calls } = fakeDb({ W: { VersionKind: 'WhatIf' }, M: { VersionKind: 'Plan' } });
    await expect(saveIntoWhatIf(db, 'M', { jobSchedules: [] } as any)).rejects.toMatchObject({ status: 409 });
    await saveIntoWhatIf(db, 'W', { scheduleId: 'gen-1', jobSchedules: [{ operationSchedules: [{}, {}] }], metrics: { otdRate: 50 } } as any);
    const upd = calls.find((c) => /UPDATE aps\.SavedSchedules SET ScheduleData/.test(c.sql))!;
    expect(JSON.parse(upd.params.data).scheduleId).toBe('W');
    expect(upd.params.opCount).toBe(2);
    expect(JSON.parse(upd.params.metrics)).toMatchObject({ otdRate: 50, violations: 0 });
  });

  it('createWhatIf copies the master when no source is given, and errors without one', async () => {
    const empty = fakeDb();
    await expect(createWhatIf(empty.db, { name: 'x', newId: 'N' })).rejects.toMatchObject({ status: 404 });
    const { db, calls } = fakeDb({
      __master: { ScheduleID: 'M', ScheduleData: '{"scheduleId":"M","jobSchedules":[]}', JobCount: 0, OperationCount: 0 },
      N: { ScheduleID: 'N', VersionKind: 'WhatIf', IsLatest: false, ScheduleData: '{"scheduleId":"N"}', SavedAt: new Date() },
    });
    const v = await createWhatIf(db, { name: 'Try Saturday', newId: 'N' });
    const ins = calls.find((c) => /INSERT INTO aps\.SavedSchedules/.test(c.sql))!;
    expect(ins.params).toMatchObject({ id: 'N', basedOn: 'M', name: 'Try Saturday' });
    expect(JSON.parse(ins.params.data).scheduleId).toBe('N');
    expect(v.kind).toBe('WhatIf');
  });

  it('metricsSnapshot keeps the KPI set only', () => {
    expect(metricsSnapshot({ metrics: { otdRate: 80, junk: 1 }, constraintViolations: [{}, {}] } as any))
      .toBe(JSON.stringify({ otdRate: 80, violations: 2 }));
    expect(metricsSnapshot({} as any)).toBeNull();
  });
});
