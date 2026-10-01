import { projectInventory } from '../inventoryProjection';

const now = new Date('2026-10-01T08:00:00');
const d = (s: string) => new Date(s);
const req = (jobId: string, componentCode: string, outstandingQty: number) => ({ jobId, componentCode, warehouseCode: '', outstandingQty });

describe('projectInventory', () => {
  it('times demand, PO receipts and outputs, and finds the first short job', () => {
    const res = projectInventory({
      now,
      jobs: [
        { jobId: 'J1', itemCode: 'FG1', start: d('2026-10-02T08:00:00'), end: d('2026-10-02T16:00:00') },
        { jobId: 'J2', itemCode: 'FG2', start: d('2026-10-05T08:00:00'), end: d('2026-10-05T16:00:00') },
      ],
      requirementsByJob: new Map([
        ['J1', [req('J1', 'RM1', 60)]],
        ['J2', [req('J2', 'RM1', 60)]],
        ['OTHER', [req('OTHER', 'RM1', 10)]], // open job not in the plan
      ]),
      stock: [{ code: 'RM1', warehouseCode: 'A', qtyOnHand: 100, qtyAllocSO: 5, description: 'Raw 1', unitOfMeasure: 'KG' }],
      poReceipts: [{ componentCode: 'RM1', promiseDate: d('2026-10-07T00:00:00'), outstandingQty: 50, poNumber: 'P1' }],
    });
    expect(res).toHaveLength(1);
    const r = res[0];
    expect(r.opening).toBe(85); // 100 − 5 SO − 10 other job
    expect(r.events.map((e) => [e.kind, e.ref, e.balance])).toEqual([
      ['demand', 'J1', 25], ['demand', 'J2', -35], ['po', 'P1', 15],
    ]);
    expect(r.status).toBe('short');
    expect(r.firstShort).toMatchObject({ jobId: 'J2', shortQty: 35 });
    expect(r.minBalance).toBe(-35);
    expect(r.finalBalance).toBe(15);
    expect(r.daily[0]).toEqual({ day: '2026-10-01', balance: 85 });
    expect(r.daily.find((x) => x.day === '2026-10-05')!.balance).toBe(-35);
    expect(r.daily[r.daily.length - 1]).toEqual({ day: '2026-10-07', balance: 15 });
  });

  it('a planned sub-assembly job supplies the component at its end', () => {
    const res = projectInventory({
      now,
      jobs: [
        { jobId: 'SUB', itemCode: 'SA1', quantity: 20, start: d('2026-10-02T08:00:00'), end: d('2026-10-02T12:00:00') },
        { jobId: 'TOP', itemCode: 'FG1', start: d('2026-10-02T12:00:00'), end: d('2026-10-03T12:00:00') },
      ],
      requirementsByJob: new Map([['TOP', [req('TOP', 'SA1', 20)]]]),
      stock: [],
      poReceipts: [],
    });
    expect(res[0].events.map((e) => [e.kind, e.balance])).toEqual([['output', 20], ['demand', 0]]);
    expect(res[0].status).toBe('ok');
  });

  it('overdue POs land now; unscheduled jobs are listed, not timed', () => {
    const res = projectInventory({
      now,
      jobs: [{ jobId: 'J1', itemCode: 'FG1' }],
      requirementsByJob: new Map([['J1', [req('J1', 'RM1', 5)]]]),
      stock: [],
      poReceipts: [{ componentCode: 'RM1', promiseDate: d('2026-09-01T00:00:00'), outstandingQty: 3 }],
    });
    expect(res[0].events).toHaveLength(1);
    expect(res[0].events[0].date).toBe(now.toISOString());
    expect(res[0].unscheduledDemand).toEqual([{ jobId: 'J1', qty: 5 }]);
    expect(res[0].status).toBe('ok');
  });

  it('nothing to project without planned demand', () => {
    expect(projectInventory({ now, jobs: [], requirementsByJob: new Map(), stock: [], poReceipts: [] })).toEqual([]);
  });
});
