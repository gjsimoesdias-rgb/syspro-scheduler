import { firstMaterialAvailability } from '../materialAvailability';

const now = new Date('2026-10-01T08:00:00Z');
const req = (jobId: string, componentCode: string, outstandingQty: number) =>
  ({ jobId, componentCode, warehouseCode: '', outstandingQty });

describe('firstMaterialAvailability', () => {
  it('in stock → now; earlier jobs claim stock first, the next waits for the PO', () => {
    const r = firstMaterialAvailability({
      jobs: [{ jobId: 'B', start: '2026-10-05' }, { jobId: 'A', start: '2026-10-02' }],
      requirementsByJob: new Map([['A', [req('A', 'RM1', 80)]], ['B', [req('B', 'RM1', 50)]]]),
      stock: [{ code: 'RM1', warehouseCode: 'W', qtyOnHand: 100, qtyAllocSO: 0 }],
      poReceipts: [{ componentCode: 'RM1', promiseDate: new Date('2026-10-04T00:00:00Z'), outstandingQty: 100 }],
      now,
    });
    expect(r.A).toMatchObject({ status: 'in-stock', fmad: now.toISOString() });
    expect(r.B).toMatchObject({ status: 'on-order', fmad: '2026-10-04T00:00:00.000Z', limiting: 'RM1' });
  });

  it('falls back to lead time, else no supply; the latest component sets the date', () => {
    const r = firstMaterialAvailability({
      jobs: [{ jobId: 'J', dueDate: '2026-10-10' }, { jobId: 'K' }],
      requirementsByJob: new Map([
        ['J', [req('J', 'RM1', 5), req('J', 'RM2', 5)]],
        ['K', [req('K', 'RM3', 1)]],
      ]),
      stock: [{ code: 'RM1', warehouseCode: 'W', qtyOnHand: 10, qtyAllocSO: 0 }],
      poReceipts: [],
      leadTimeDays: new Map([['RM2', 7]]),
      now,
    });
    expect(r.J).toMatchObject({ status: 'lead-time', limiting: 'RM2', fmad: new Date(now.getTime() + 7 * 86400000).toISOString() });
    expect(r.K).toMatchObject({ status: 'no-supply', fmad: null, limiting: 'RM3' });
  });

  it('jobs without outstanding materials have no FMAD', () => {
    const r = firstMaterialAvailability({ jobs: [{ jobId: 'X' }], requirementsByJob: new Map(), stock: [], poReceipts: [], now });
    expect(r.X).toEqual({ fmad: null, status: 'no-materials', components: 0 });
  });
});
