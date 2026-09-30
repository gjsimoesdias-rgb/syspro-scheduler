/**
 * SysproDatabaseService.mapRowToJob — SYSPRO row → Job mapping (PLAN §4.2).
 *
 * Covers the master/sub hierarchy fields added for precedence scheduling,
 * date/time combination, and defaulting behaviour. The method is private;
 * tests reach it via `as any`, which is acceptable for a pure mapper.
 */

import SysproDatabaseService from '../SysproDatabaseService';

function makeService(): any {
  // The mapper never touches the db — a bare stub is enough.
  return new (SysproDatabaseService as any)({} as any);
}

function baseRow(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    jobId: 'J-100',
    itemCode: 'ITEM-1',
    description: 'Test job',
    quantity: '25',
    dueDate: '2026-08-01',
    releaseDate: '2026-07-10',
    priority: '3',
    status: 'Released',
    estimatedMaterialCost: '12.5',
    ...overrides,
  };
}

describe('mapRowToJob — master/sub hierarchy fields', () => {
  it('maps masterJobId, isMasterJob, isSubJob from the WipMasterSub join', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(
      baseRow({ masterJobId: 'MST-9', IsMasterJob: false, IsSubJob: true }),
      [],
    );
    expect(job.masterJobId).toBe('MST-9');
    expect(job.isMasterJob).toBe(false);
    expect(job.isSubJob).toBe(true);
  });

  it('accepts SQL bit values (1/0) for the flags', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(baseRow({ IsMasterJob: 1, IsSubJob: 0 }), []);
    expect(job.isMasterJob).toBe(true);
    expect(job.isSubJob).toBe(false);
  });

  it('falls back to the MasterJob alias and defaults to null when absent', () => {
    const svc = makeService();
    const viaAlias = svc.mapRowToJob(baseRow({ MasterJob: 'MST-2' }), []);
    expect(viaAlias.masterJobId).toBe('MST-2');

    const standalone = svc.mapRowToJob(baseRow(), []);
    expect(standalone.masterJobId).toBeNull();
    expect(standalone.isMasterJob).toBe(false);
    expect(standalone.isSubJob).toBe(false);
  });
});

describe('mapRowToJob — core field mapping', () => {
  it('coerces numerics and keeps identity fields', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(baseRow(), []);
    expect(job.jobId).toBe('J-100');
    expect(job.itemCode).toBe('ITEM-1');
    expect(job.quantity).toBe(25);
    expect(job.priority).toBe(3);
    expect(job.estimatedMaterialCost).toBe(12.5);
    expect(job.status).toBe('Released');
  });

  it('applies defaults for missing description, priority, and quantity', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(
      baseRow({ description: undefined, priority: undefined, quantity: undefined }),
      [],
    );
    expect(job.description).toBe('N/A');
    expect(job.priority).toBe(5);
    expect(job.quantity).toBe(0);
  });

  it('combines a SYSPRO delivery time (HH:mm string) into the due date', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(
      baseRow({ dueDate: '2026-08-01T00:00:00', JobDeliveryTime: '14:30' }),
      [],
    );
    expect(job.dueDate.getHours()).toBe(14);
    expect(job.dueDate.getMinutes()).toBe(30);
  });

  it('combines a numeric SYSPRO time (e.g. 830 → 08:30) into the release date', () => {
    const svc = makeService();
    const job = svc.mapRowToJob(
      baseRow({ releaseDate: '2026-07-10T00:00:00', JobStartTime: 830 }),
      [],
    );
    expect(job.releaseDate.getHours()).toBe(8);
    expect(job.releaseDate.getMinutes()).toBe(30);
  });

  it('attaches the supplied operations array', () => {
    const svc = makeService();
    const ops = [{ opId: 'OP1' } as any];
    const job = svc.mapRowToJob(baseRow(), ops);
    expect(job.operations).toBe(ops);
  });
});

describe('mapRowToJob — duplicated MasterJob column', () => {
  it('reads the link from an mssql array and ignores empty arrays', () => {
    const svc = makeService();
    expect(svc.mapRowToJob(baseRow({ masterJobId: null, MasterJob: ['', null] }), []).masterJobId).toBeNull();
    expect(svc.mapRowToJob(baseRow({ masterJobId: null, MasterJob: ['', '000000000038413'] }), []).masterJobId).toBe('000000000038413');
  });
});
