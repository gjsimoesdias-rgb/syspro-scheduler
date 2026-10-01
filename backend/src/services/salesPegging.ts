/**
 * Sales-order pegging — which supply covers each open SYSPRO sales-order line
 * on the current plan, and whether it ships on time. Pure, unit-tested.
 *
 * Per stock code:
 *  1. Jobs raised for a specific order line (WipMaster.SalesOrder/Line) go to
 *     that line first.
 *  2. Remaining lines, earliest ship date first, take stock on hand (available
 *     now), then planned jobs that make the item in order of planned finish.
 *  3. A line is
 *       on-time     — covered, and the last supply arrives by its ship date
 *       late        — covered, but after the ship date (daysLate)
 *       unscheduled — covered only with a job that has no planned dates
 *       short       — not enough stock + jobs in the plan
 */

export interface SoLine {
  salesOrder: string;
  line: number;
  customer?: string;
  customerName?: string;
  customerPo?: string;
  stockCode: string;
  description?: string;
  unitOfMeasure?: string;
  warehouse?: string;
  openQty: number;
  shipDate?: Date | string | null;
}

export interface PegJob {
  jobId: string;
  itemCode?: string;
  quantity?: number;
  start?: Date | string | null;
  end?: Date | string | null;
  salesOrder?: string;
  salesOrderLine?: number;
}

export interface Peg { source: 'stock' | 'job'; jobId?: string; qty: number; availableAt: string | null; direct?: boolean }

export interface PeggedLine {
  salesOrder: string;
  line: number;
  customer?: string;
  customerName?: string;
  customerPo?: string;
  stockCode: string;
  description?: string;
  unitOfMeasure?: string;
  openQty: number;
  shipDate: string | null;
  pegs: Peg[];
  shortQty: number;
  availableAt: string | null;
  status: 'on-time' | 'late' | 'unscheduled' | 'short';
  daysLate: number;
}

export interface JobPeg { salesOrder: string; line: number; customerName?: string; qty: number; shipDate: string | null; status: PeggedLine['status'] }

const norm = (s: unknown) => String(s ?? '').trim();
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const EPS = 1e-6;
/** SO numbers are zero-padded in SYSPRO; compare without leading zeros. */
const soKey = (so: unknown, line: unknown) => `${norm(so).replace(/^0+(?=.)/, '')}#${Number(line) || 0}`;

export function pegSalesOrders(args: {
  lines: SoLine[];
  jobs: PegJob[];
  /** QtyOnHand per stock code (all warehouses). */
  onHand: Map<string, number>;
  now?: Date;
}): { lines: PeggedLine[]; byJob: Record<string, JobPeg[]> } {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  type Supply = { jobId?: string; at: Date | null; left: number };
  const stockLeft = new Map<string, number>();
  for (const [code, q] of args.onHand) stockLeft.set(norm(code), Math.max(0, Number(q) || 0));

  const jobSupply = new Map<string, Supply[]>(); // by stock code, finish order
  const jobById = new Map<string, Supply>();
  for (const j of args.jobs) {
    const code = norm(j.itemCode);
    const q = Number(j.quantity) || 0;
    if (!code || q <= 0) continue;
    const end = toDate(j.end);
    const s: Supply = { jobId: norm(j.jobId), at: end && end < now ? now : end, left: q };
    jobById.set(s.jobId!, s);
    const list = jobSupply.get(code) || [];
    list.push(s);
    jobSupply.set(code, list);
  }
  for (const list of jobSupply.values()) {
    list.sort((a, b) => (a.at ? a.at.getTime() : Infinity) - (b.at ? b.at.getTime() : Infinity));
  }

  const work = args.lines
    .filter((l) => norm(l.stockCode) && (Number(l.openQty) || 0) > EPS)
    .map((l) => ({ l, ship: toDate(l.shipDate), need: Number(l.openQty) || 0, pegs: [] as Peg[] }));
  const byKey = new Map(work.map((w) => [soKey(w.l.salesOrder, w.l.line), w]));

  // 1. Jobs raised for a specific order line.
  for (const j of args.jobs) {
    if (!norm(j.salesOrder)) continue;
    const w = byKey.get(soKey(j.salesOrder, j.salesOrderLine));
    const s = jobById.get(norm(j.jobId));
    if (!w || !s || norm(w.l.stockCode) !== norm(j.itemCode)) continue;
    const q = Math.min(w.need, s.left);
    if (q <= EPS) continue;
    w.pegs.push({ source: 'job', jobId: s.jobId, qty: r4(q), availableAt: s.at ? s.at.toISOString() : null, direct: true });
    w.need -= q; s.left -= q;
  }

  // 2. Earliest ship date first: stock, then jobs by planned finish.
  work.sort((a, b) =>
    (a.ship ? a.ship.getTime() : Infinity) - (b.ship ? b.ship.getTime() : Infinity) ||
    norm(a.l.salesOrder).localeCompare(norm(b.l.salesOrder)) || a.l.line - b.l.line);
  for (const w of work) {
    const code = norm(w.l.stockCode);
    const st = stockLeft.get(code) || 0;
    if (w.need > EPS && st > EPS) {
      const q = Math.min(w.need, st);
      w.pegs.push({ source: 'stock', qty: r4(q), availableAt: nowIso });
      w.need -= q; stockLeft.set(code, st - q);
    }
    for (const s of jobSupply.get(code) || []) {
      if (w.need <= EPS) break;
      if (s.left <= EPS) continue;
      const q = Math.min(w.need, s.left);
      w.pegs.push({ source: 'job', jobId: s.jobId, qty: r4(q), availableAt: s.at ? s.at.toISOString() : null });
      w.need -= q; s.left -= q;
    }
  }

  // 3. Status per line, and the reverse index per job.
  const byJob: Record<string, JobPeg[]> = {};
  const lines: PeggedLine[] = work.map((w) => {
    const shortQty = w.need > EPS ? r4(w.need) : 0;
    const undated = w.pegs.some((p) => !p.availableAt);
    const times = w.pegs.filter((p) => p.availableAt).map((p) => new Date(p.availableAt!).getTime());
    const availableAt = !undated && times.length ? new Date(Math.max(...times)).toISOString() : null;
    // Late = available after the end of the ship day.
    const shipEnd = w.ship ? new Date(w.ship.getFullYear(), w.ship.getMonth(), w.ship.getDate() + 1) : null;
    const lateMs = availableAt && shipEnd ? new Date(availableAt).getTime() - shipEnd.getTime() : 0;
    const status: PeggedLine['status'] = shortQty > 0 ? 'short' : undated ? 'unscheduled' : lateMs > 0 ? 'late' : 'on-time';
    const out: PeggedLine = {
      salesOrder: norm(w.l.salesOrder),
      line: w.l.line,
      customer: w.l.customer,
      customerName: w.l.customerName,
      customerPo: w.l.customerPo,
      stockCode: norm(w.l.stockCode),
      description: w.l.description,
      unitOfMeasure: w.l.unitOfMeasure,
      openQty: r4(Number(w.l.openQty) || 0),
      shipDate: w.ship ? w.ship.toISOString() : null,
      pegs: w.pegs,
      shortQty,
      availableAt,
      status,
      daysLate: status === 'late' ? Math.ceil(lateMs / 86400000) : 0,
    };
    for (const p of w.pegs) {
      if (p.source !== 'job' || !p.jobId) continue;
      (byJob[p.jobId] ||= []).push({
        salesOrder: out.salesOrder, line: out.line, customerName: out.customerName,
        qty: p.qty, shipDate: out.shipDate, status,
      });
    }
    return out;
  });

  return { lines, byJob };
}
