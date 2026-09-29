/**
 * Material availability — services/materialPlan.ts (the one formula used by the
 * scheduler, /jobs/material-plan and the BOM modal). Replaces the old
 * getJobMaterialPlans tests, whose model double-counted WIP allocations.
 */
import { computeMaterialPlans, RequirementLine, StockRow, PoReceipt } from '../materialPlan';

const job = (jobId: string, due = '2026-10-20') => ({ jobId, itemCode: `FG-${jobId}`, releaseDate: '2026-10-01', dueDate: due });
const req = (jobId: string, code: string, qty: number, wh = 'PROD'): RequirementLine =>
  ({ jobId, componentCode: code, warehouseCode: wh, outstandingQty: qty, unitOfMeasure: 'EA' });
const stock = (code: string, onHand: number, so = 0, wh = 'PROD'): StockRow =>
  ({ code, warehouseCode: wh, qtyOnHand: onHand, qtyAllocSO: so });
const reqs = (...lines: RequirementLine[]) => {
  const m = new Map<string, RequirementLine[]>();
  for (const l of lines) m.set(l.jobId, [...(m.get(l.jobId) || []), l]);
  return m;
};

describe('computeMaterialPlans', () => {
  it('empty job list → empty result', () => {
    expect(computeMaterialPlans({ jobs: [], requirementsByJob: new Map(), stock: [], poReceipts: [] }).size).toBe(0);
  });

  it('job with no outstanding lines is OK', () => {
    const r = computeMaterialPlans({ jobs: [job('J1')], requirementsByJob: new Map(), stock: [], poReceipts: [] });
    expect(r.get('J1')).toMatchObject({ status: 'Materials', available: true, shortages: [] });
  });

  it('uses the outstanding need (issued material no longer counts)', () => {
    // 100 required, 90 already issued → outstanding 10; 10 on hand is enough.
    const r = computeMaterialPlans({
      jobs: [job('J1')], requirementsByJob: reqs(req('J1', 'C1', 10)), stock: [stock('C1', 10)], poReceipts: [],
    });
    expect(r.get('J1')!.status).toBe('Materials');
  });

  it('sales-order allocations reduce supply; WIP allocation is NOT subtracted again', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1')], requirementsByJob: reqs(req('J1', 'C1', 60)), stock: [stock('C1', 100, 50)], poReceipts: [],
    });
    expect(r.get('J1')!.shortages[0]).toMatchObject({ requiredQty: 60, availableQty: 50, shortageQty: 10 });
    expect(r.get('J1')!.status).toBe('Partial');
  });

  it('open jobs outside the run keep their share', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1')],
      requirementsByJob: reqs(req('J1', 'C1', 30), req('OTHER', 'C1', 80)),
      stock: [stock('C1', 100)], poReceipts: [],
    });
    expect(r.get('J1')!.shortages[0]).toMatchObject({ availableQty: 20, shortageQty: 10 });
  });

  it('jobs in the run consume supply in order (priority order by default)', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1'), job('J2')],
      requirementsByJob: reqs(req('J1', 'C1', 70), req('J2', 'C1', 70)),
      stock: [stock('C1', 100)], poReceipts: [],
    });
    expect(r.get('J1')!.status).toBe('Materials');
    expect(r.get('J2')!.shortages[0]).toMatchObject({ availableQty: 30, shortageQty: 40 });
  });

  it('schedule order overrides the given order', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1'), job('J2')],
      requirementsByJob: reqs(req('J1', 'C1', 70), req('J2', 'C1', 70)),
      stock: [stock('C1', 100)], poReceipts: [], order: ['J2', 'J1'],
    });
    expect(r.get('J2')!.status).toBe('Materials');
    expect(r.get('J1')!.status).toBe('Partial');
  });

  it('a line draws only on its own warehouse', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1')], requirementsByJob: reqs(req('J1', 'C1', 10, 'PROD')),
      stock: [stock('C1', 0, 0, 'PROD'), stock('C1', 500, 0, 'WP')], poReceipts: [],
    });
    expect(r.get('J1')!.status).toBe('No Materials');
  });

  it('a line with no warehouse uses the total across warehouses', () => {
    const r = computeMaterialPlans({
      jobs: [job('J1')], requirementsByJob: reqs(req('J1', 'C1', 10, '')),
      stock: [stock('C1', 4, 0, 'PROD'), stock('C1', 6, 0, 'WP')], poReceipts: [],
    });
    expect(r.get('J1')!.status).toBe('Materials');
  });

  it('PO receipts count only if promised on/before the need date (and same warehouse)', () => {
    const po = (qty: number, promise: string | null, wh = 'PROD'): PoReceipt =>
      ({ componentCode: 'C1', warehouseCode: wh, promiseDate: promise ? new Date(promise) : null, outstandingQty: qty });
    const run = (receipts: PoReceipt[]) => computeMaterialPlans({
      jobs: [job('J1')], requirementsByJob: reqs(req('J1', 'C1', 10)), stock: [], poReceipts: receipts,
    }).get('J1')!.status;
    expect(run([po(10, '2026-09-25')])).toBe('Materials');
    expect(run([po(10, '2026-12-01')])).toBe('No Materials');
    expect(run([po(10, null)])).toBe('Materials');
    expect(run([po(10, '2026-09-25', 'WP')])).toBe('No Materials');
  });
});
