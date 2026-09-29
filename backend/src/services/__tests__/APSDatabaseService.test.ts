/**
 * Unit tests for APSDatabaseService.
 *
 * Uses a hand-rolled FakeSysproDb that captures every query call and lets
 * tests pre-configure responses, so no real SQL Server is required.
 *
 * Test coverage (12 cases):
 *  1.  refreshApsCache resolves and calls the right sproc
 *  2.  refreshApsCache re-throws on DB error
 *  3.  exportSchedule: refreshApsCache is called BEFORE the transaction opens
 *  4.  exportSchedule: empty jobSchedules — CreateWIBPL is never called
 *  5.  exportSchedule: WipMaster UPDATE runs after APS sproc
 *  6.  exportSchedule: CreateWIBPL empty result → success: false
 *  7.  exportSchedule: WipMaster @@ROWCOUNT=0 → success: false
 *  8.  exportSchedule: refreshApsCache failure → success: false, no transaction
 *  9.  populateSchedulerRecordSummary: INSERT uses queryWithParams (parameterised)
 * 10.  populateSchedulerRecordSummary: jobId never appears raw in the SQL string
 * 11.  writeBackToWipJobAllLab: date params are ISO strings, not Date objects
 * 12.  cleanupClosedOperations: calls parameterised sproc and returns rowsDeleted
 */

import APSDatabaseService from '../APSDatabaseService';
import { Schedule, JobSchedule, OperationSchedule } from '../../types';

// ---------------------------------------------------------------------------
// Test double for DatabaseConnection
// ---------------------------------------------------------------------------

type Recordset = Array<Record<string, any>>;

interface CapturedCall {
  kind: 'query' | 'queryWithParams' | 'execute' | 'withTransaction';
  sql: string;
  params?: Record<string, any>;
}

/**
 * Unified fake: outer and inner (transaction) calls all land in .calls[].
 * withTransaction passes `this` as the DbExecutor so that the call order is
 * preserved across the refresh → transaction boundary.
 */
class FakeSysproDb {
  calls: CapturedCall[] = [];

  private responses: Array<[(sql: string) => boolean, Recordset]> = [];
  private failPatterns: Array<(sql: string) => boolean> = [];

  whenSql(matcher: (sql: string) => boolean, rows: Recordset): this {
    this.responses.unshift([matcher, rows]);
    return this;
  }

  failWhenSql(matcher: (sql: string) => boolean): this {
    this.failPatterns.push(matcher);
    return this;
  }

  private resolve(sql: string): Recordset {
    if (this.failPatterns.some((f) => f(sql))) {
      throw new Error(`Simulated DB failure for: ${sql.slice(0, 60)}`);
    }
    for (const [match, rows] of this.responses) {
      if (match(sql)) return rows;
    }
    return [];
  }

  async query(sql: string): Promise<{ recordset: Recordset }> {
    this.calls.push({ kind: 'query', sql });
    return { recordset: this.resolve(sql) };
  }

  async queryWithParams(
    sql: string,
    params: Record<string, any>
  ): Promise<{ recordset: Recordset }> {
    this.calls.push({ kind: 'queryWithParams', sql, params });
    return { recordset: this.resolve(sql) };
  }

  async execute(procedure: string, params: Record<string, any> = {}): Promise<any> {
    this.calls.push({ kind: 'execute', sql: procedure, params });
    return { recordset: [] };
  }

  async withTransaction<T>(callback: (db: any) => Promise<T>): Promise<T> {
    // Record the transaction boundary so tests can assert call ordering.
    this.calls.push({ kind: 'withTransaction', sql: '__begin__' });
    // Re-use `this` as the inner executor so the same responses/failures
    // apply inside the transaction and all calls stay in one ordered list.
    return callback(this);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS_START = new Date('2025-05-01T08:00:00');
const TS_END = new Date('2025-05-01T10:00:00');

function makeOp(opId = 'OP10'): OperationSchedule {
  return {
    opId,
    workcentreId: 'WC01',
    resourceId: 'M01',
    plannedStartDate: TS_START,
    plannedEndDate: TS_END,
    duration: 120,
    setupTime: 0,
    runTime: 120,
    queueTime: 0,
    moveTime: 0,
    setupStart: TS_START,
    setupEnd: TS_START,
    runStart: TS_START,
    runEnd: TS_END,
    queueEnd: TS_START,
    moveEnd: TS_END,
    sequence: 10,
    isOvertimeSlot: false,
    batchSize: 1,
    slackTime: 0,
  };
}

function makeJobSchedule(jobId = 'J01', ops: OperationSchedule[] = []): JobSchedule {
  return {
    jobId,
    plannedStartDate: TS_START,
    plannedEndDate: TS_END,
    operationSchedules: ops,
    estimatedTardiness: 0,
    status: 'Scheduled',
  };
}

function makeSchedule(jobSchedules: JobSchedule[] = []): Schedule {
  return {
    scheduleId: 'sch-test-001',
    scheduledDate: new Date('2025-05-01'),
    version: 1,
    status: 'Draft',
    planningHorizon: { startDate: new Date('2025-05-01'), endDate: new Date('2025-05-28') },
    jobSchedules,
    resourceLoads: [],
    constraintViolations: [],
    metrics: {
      totalJobsScheduled: jobSchedules.length,
      jobsOnTime: jobSchedules.length,
      jobsTardy: 0,
      averageTardiness: 0,
      resourceUtilization: 0,
      overtimeHours: 0,
      criticalPathLength: 0,
      totalSetupTime: 0,
      totalQueueTime: 0,
      totalMoveTime: 0,
    },
  };
}

/**
 * Returns a FakeSysproDb pre-loaded with all "happy path" responses so a
 * full exportSchedule with one job/op completes without errors.
 */
function happyDb(): FakeSysproDb {
  const db = new FakeSysproDb();
  db.whenSql((s) => s.includes('SourceProductionOrders'), [
    { ItemNumber: 'ITEM-001', LocationCode: 'MAIN', QuantityOrdered: 5, ItemDescription: 'Test Item' },
  ]);
  db.whenSql((s) => s.includes('Lynq_VP_BPL_CreateWIBPL'), [{ OrdNumber: 'WO-TEST-001' }]);
  db.whenSql((s) => s.includes('Lynq_VP_BPL_LogSchedulingInfo'), [
    { CurrID: 1, IsScheduleChanged: 1 },
  ]);
  db.whenSql((s) => s.includes('WipJobAllLab'), [{ rowsAffected: 1 }]);
  db.whenSql((s) => s.includes('WipMaster'), [{ rowsAffected: 1 }]);
  return db;
}

// ---------------------------------------------------------------------------
// S1.1 — refreshApsCache
// ---------------------------------------------------------------------------

describe('APSDatabaseService.refreshApsCache', () => {
  it('resolves with success:true and calls the right stored procedure', async () => {
    const db = new FakeSysproDb();
    const svc = new APSDatabaseService(db as any);
    const result = await svc.refreshApsCache();

    expect(result.success).toBe(true);
    expect(
      db.calls.some((c) => c.sql.includes('RefreshLynqCompatProductionCache'))
    ).toBe(true);
  });

  it('re-throws when the DB query fails', async () => {
    const db = new FakeSysproDb();
    db.failWhenSql((s) => s.includes('RefreshLynqCompatProductionCache'));
    const svc = new APSDatabaseService(db as any);

    await expect(svc.refreshApsCache()).rejects.toThrow('Simulated DB failure');
  });
});

// ---------------------------------------------------------------------------
// S1.1 — exportSchedule: ordering and call contracts
// ---------------------------------------------------------------------------

describe('APSDatabaseService.exportSchedule — ordering', () => {
  it('calls refreshApsCache BEFORE the transaction opens', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    const refreshIdx = db.calls.findIndex((c) =>
      c.sql.includes('RefreshLynqCompatProductionCache')
    );
    const txIdx = db.calls.findIndex((c) => c.sql === '__begin__');

    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(txIdx).toBeGreaterThan(refreshIdx);
  });

  it('empty jobSchedules — Lynq_VP_BPL_CreateWIBPL is never called', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    const result = await svc.exportSchedule(makeSchedule([]));

    expect(result.success).toBe(true);
    expect(db.calls.some((c) => c.sql.includes('CreateWIBPL'))).toBe(false);
  });

  it('WipMaster UPDATE runs after Lynq_VP_BPL_CreateWIBPL', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    const sprocIdx = db.calls.findIndex((c) => c.sql.includes('Lynq_VP_BPL_CreateWIBPL'));
    const wipIdx = db.calls.findIndex((c) => c.sql.includes('UPDATE WipMaster'));

    expect(sprocIdx).toBeGreaterThanOrEqual(0);
    expect(wipIdx).toBeGreaterThan(sprocIdx);
  });
});

// ---------------------------------------------------------------------------
// S1.1 — exportSchedule: failure paths
// ---------------------------------------------------------------------------

describe('APSDatabaseService.exportSchedule — failure paths', () => {
  it('CreateWIBPL returning empty recordset → export success: false', async () => {
    const db = new FakeSysproDb();
    db.whenSql((s) => s.includes('SourceProductionOrders'), [
      { ItemNumber: 'ITEM-001', LocationCode: 'MAIN', QuantityOrdered: 5, ItemDescription: 'Test' },
    ]);
    // No OrdNumber in the result — writeJobSchedule returns { success: false }
    db.whenSql((s) => s.includes('Lynq_VP_BPL_CreateWIBPL'), []);

    const svc = new APSDatabaseService(db as any);
    const result = await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    expect(result.success).toBe(false);
    expect(result.errorMessages.length).toBeGreaterThan(0);
  });

  it('WipMaster @@ROWCOUNT=0 → export success: false', async () => {
    const db = new FakeSysproDb();
    db.whenSql((s) => s.includes('SourceProductionOrders'), [
      { ItemNumber: 'ITEM-001', LocationCode: 'MAIN', QuantityOrdered: 5, ItemDescription: 'Test' },
    ]);
    db.whenSql((s) => s.includes('Lynq_VP_BPL_CreateWIBPL'), [{ OrdNumber: 'WO-001' }]);
    db.whenSql((s) => s.includes('Lynq_VP_BPL_LogSchedulingInfo'), [
      { CurrID: 1, IsScheduleChanged: 1 },
    ]);
    db.whenSql((s) => s.includes('WipJobAllLab'), [{ rowsAffected: 1 }]);
    // Zero rows affected on WipMaster — must trigger rollback
    db.whenSql((s) => s.includes('WipMaster'), [{ rowsAffected: 0 }]);

    const svc = new APSDatabaseService(db as any);
    const result = await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    expect(result.success).toBe(false);
  });

  it('refreshApsCache failure → export success: false, no transaction opened', async () => {
    const db = new FakeSysproDb();
    db.failWhenSql((s) => s.includes('RefreshLynqCompatProductionCache'));

    const svc = new APSDatabaseService(db as any);
    const result = await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    expect(result.success).toBe(false);
    // The transaction must NOT have been opened
    expect(db.calls.some((c) => c.sql === '__begin__')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S1.1 — populateSchedulerRecordSummary: parameterised SQL
// ---------------------------------------------------------------------------

describe('APSDatabaseService — populateSchedulerRecordSummary', () => {
  it('INSERT into SchedulerRecordSummary uses queryWithParams (not a raw query with jobId)', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    const jobId = 'SPECIFIC-JOB-XYZ';
    const js = makeJobSchedule(jobId, [makeOp()]);
    await svc.exportSchedule(makeSchedule([js]));

    const insertCalls = db.calls.filter(
      (c) => c.kind === 'queryWithParams' && c.sql.includes('SchedulerRecordSummary') && c.sql.includes('INSERT')
    );

    expect(insertCalls.length).toBeGreaterThan(0);
    // The raw jobId string must not appear in the SQL text
    for (const call of insertCalls) {
      expect(call.sql).not.toContain(jobId);
      // The service batches rows: params are keyed ordNumber0, ordNumber1, …
      // At least one ordNumber-prefixed key must exist in every INSERT call.
      const hasOrdNumberParam = Object.keys(call.params ?? {}).some((k) =>
        k.startsWith('ordNumber')
      );
      expect(hasOrdNumberParam).toBe(true);
    }
  });

  it('jobId value in INSERT is passed via params, never concatenated into SQL', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    const injectionJobId = "INJECTION'; DROP TABLE aps.SchedulerRecordSummary; --";
    const js = makeJobSchedule(injectionJobId, [makeOp()]);
    await svc.exportSchedule(makeSchedule([js]));

    // The literal injection string (or its DROP TABLE fragment) must never appear
    // in the SQL text of any call. Note: legitimate SQL uses -- for comments, so
    // we check for the specific injection payload rather than '--' on its own.
    const dangerousSql = db.calls.filter(
      (c) => c.sql.includes('DROP TABLE') || c.sql.includes("INJECTION'")
    );
    expect(dangerousSql).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S1.1 — date serialisation
// ---------------------------------------------------------------------------

describe('APSDatabaseService — date serialisation', () => {
  it('writeBackToWipJobAllLab: date params are ISO strings, not Date objects', async () => {
    const db = happyDb();
    const svc = new APSDatabaseService(db as any);
    await svc.exportSchedule(makeSchedule([makeJobSchedule('J01', [makeOp()])]));

    const wipCalls = db.calls.filter(
      (c) => c.kind === 'queryWithParams' && c.sql.includes('WipJobAllLab')
    );

    expect(wipCalls.length).toBeGreaterThan(0);
    for (const call of wipCalls) {
      if (call.params?.startDate !== undefined) {
        expect(typeof call.params.startDate).toBe('string');
        // Must match yyyy-mm-ddThh:mm:ss (ISO with T separator)
        expect(call.params.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      }
      if (call.params?.endDate !== undefined) {
        expect(typeof call.params.endDate).toBe('string');
        expect(call.params.endDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S1.1 — cleanupClosedOperations
// ---------------------------------------------------------------------------

describe('APSDatabaseService.cleanupClosedOperations', () => {
  it('calls the parameterised sproc with the supplied dayOffset and returns rowsDeleted', async () => {
    const db = new FakeSysproDb();
    db.whenSql((s) => s.includes('DeleteClosedOperations'), [{ DeletedCount: 7 }]);

    const svc = new APSDatabaseService(db as any);
    const result = await svc.cleanupClosedOperations(3);

    expect(result.rowsDeleted).toBe(7);

    const call = db.calls.find((c) => c.sql.includes('DeleteClosedOperations'));
    expect(call).toBeDefined();
    expect(call!.kind).toBe('queryWithParams');
    expect(call!.params).toMatchObject({ p_DayOffset: 3 });
  });

  it('returns rowsDeleted: 0 and does not throw when the sproc fails', async () => {
    const db = new FakeSysproDb();
    db.failWhenSql((s) => s.includes('DeleteClosedOperations'));

    const svc = new APSDatabaseService(db as any);
    const result = await svc.cleanupClosedOperations(0);

    expect(result.rowsDeleted).toBe(0);
  });
});
