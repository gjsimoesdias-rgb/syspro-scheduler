import { pegSalesOrders } from '../salesPegging';

const now = new Date('2026-10-01T08:00:00');
const d = (s: string) => new Date(s);
const line = (so: string, ln: number, code: string, qty: number, ship: string | null, name = 'Cust') =>
  ({ salesOrder: so, line: ln, stockCode: code, openQty: qty, shipDate: ship ? d(ship) : null, customerName: name });

describe('pegSalesOrders', () => {
  it('earliest ship date takes stock first, then jobs by planned finish', () => {
    const { lines, byJob } = pegSalesOrders({
      now,
      onHand: new Map([['FG1', 100]]),
      jobs: [
        { jobId: 'J2', itemCode: 'FG1', quantity: 200, end: d('2026-10-08T12:00:00') },
        { jobId: 'J1', itemCode: 'FG1', quantity: 100, end: d('2026-10-03T12:00:00') },
      ],
      lines: [
        line('SO2', 1, 'FG1', 150, '2026-10-05T00:00:00'),
        line('SO1', 1, 'FG1', 120, '2026-10-02T00:00:00'),
        line('SO3', 1, 'FG1', 200, '2026-10-20T00:00:00'),
      ],
    });
    const by = Object.fromEntries(lines.map((l) => [l.salesOrder, l]));
    // SO1 (ships 2 Oct): 100 stock + 20 from J1 (3 Oct) → late 1 day
    expect(by.SO1.pegs.map((p) => [p.source, p.jobId, p.qty])).toEqual([['stock', undefined, 100], ['job', 'J1', 20]]);
    expect(by.SO1).toMatchObject({ status: 'late', daysLate: 1 });
    // SO2 (5 Oct): 80 from J1, 70 from J2 (8 Oct) → late
    expect(by.SO2.pegs.map((p) => [p.jobId, p.qty])).toEqual([['J1', 80], ['J2', 70]]);
    expect(by.SO2.status).toBe('late');
    // SO3 (20 Oct): 130 left on J2 → short 70
    expect(by.SO3).toMatchObject({ status: 'short', shortQty: 70 });
    expect(byJob.J1.map((p) => [p.salesOrder, p.qty])).toEqual([['SO1', 20], ['SO2', 80]]);
  });

  it('a job raised for an order line goes to that line first (SO number zero-padding ignored)', () => {
    const { lines } = pegSalesOrders({
      now,
      onHand: new Map(),
      jobs: [{ jobId: 'J9', itemCode: 'FG1', quantity: 50, end: d('2026-10-02T10:00:00'), salesOrder: '000123', salesOrderLine: 2 }],
      lines: [line('100', 1, 'FG1', 50, '2026-10-01T00:00:00'), line('123', 2, 'FG1', 50, '2026-10-09T00:00:00')],
    });
    const by = Object.fromEntries(lines.map((l) => [l.salesOrder, l]));
    expect(by['123'].pegs[0]).toMatchObject({ jobId: 'J9', direct: true, qty: 50 });
    expect(by['123'].status).toBe('on-time');
    expect(by['100'].status).toBe('short');
  });

  it('jobs without dates make the line unscheduled; ready on the ship day counts as on time', () => {
    const { lines } = pegSalesOrders({
      now,
      onHand: new Map(),
      jobs: [
        { jobId: 'JU', itemCode: 'A', quantity: 10 },
        { jobId: 'JD', itemCode: 'B', quantity: 10, end: d('2026-10-05T22:00:00') },
      ],
      lines: [line('S1', 1, 'A', 10, '2026-10-05T00:00:00'), line('S2', 1, 'B', 10, '2026-10-05T00:00:00')],
    });
    expect(lines.find((l) => l.salesOrder === 'S1')!.status).toBe('unscheduled');
    expect(lines.find((l) => l.salesOrder === 'S2')!.status).toBe('on-time');
  });

  it('ship date already passed → past due, with how late the plan can still supply it', () => {
    const { lines } = pegSalesOrders({
      now,
      onHand: new Map([['A', 5]]),
      jobs: [{ jobId: 'J', itemCode: 'A', quantity: 5, end: d('2026-10-03T10:00:00') }],
      lines: [line('OLD', 1, 'A', 10, '2026-09-20T00:00:00')],
    });
    expect(lines[0]).toMatchObject({ status: 'past-due', daysLate: 13 });
  });
});
