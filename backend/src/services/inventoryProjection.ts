/**
 * Projected inventory by day — time-phased stock for every component the plan
 * uses. Pure (no DB) and unit-tested; the inputs are the same SYSPRO reads as
 * materialPlan.ts, so the Materials view and the scheduler agree.
 *
 * Per stock code (all warehouses together):
 *   opening   = QtyOnHand − QtyAllocated (sales orders)
 *               − outstanding needs of open jobs that are NOT in the plan
 *   + PO receipt   at its promise date (else due date; overdue/undated → now)
 *   + job output   at the scheduled end of a planned job that MAKES the code
 *   − job demand   at the scheduled start of a planned job that USES the code
 * Same instant: receipts and outputs land before demand.
 * Planned jobs without dates are listed as unscheduled demand, not timed.
 */
import type { RequirementLine, StockRow, PoReceipt } from './materialPlan';

export interface ProjectionJob {
  jobId: string;
  itemCode?: string;
  quantity?: number;
  start?: Date | string | null;
  end?: Date | string | null;
}

export interface ProjectionEvent {
  date: string; // ISO
  kind: 'po' | 'output' | 'demand';
  ref: string; // PO number or job id
  qty: number; // signed: + supply, − demand
  balance: number;
}

export interface ComponentProjection {
  code: string;
  description?: string;
  unitOfMeasure?: string;
  opening: number;
  onHand: number;
  events: ProjectionEvent[];
  /** Demand of planned jobs that have no dates. */
  unscheduledDemand: Array<{ jobId: string; qty: number }>;
  minBalance: number;
  finalBalance: number;
  /** First demand that takes the balance below zero. */
  firstShort?: { date: string; jobId: string; shortQty: number };
  status: 'short' | 'ok';
  /** End-of-day balance from today to the last event (inclusive). */
  daily: Array<{ day: string; balance: number }>;
}

const norm = (s: unknown) => String(s ?? '').trim();
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const round = (n: number) => Math.round(n * 10000) / 10000;

export function projectInventory(args: {
  jobs: ProjectionJob[];
  requirementsByJob: Map<string, RequirementLine[]>;
  stock: Array<StockRow & { description?: string; unitOfMeasure?: string }>;
  poReceipts: Array<PoReceipt & { poNumber?: string; dueDate?: Date | null }>;
  now?: Date;
  /** Cap on the daily series (days). */
  maxDays?: number;
}): ComponentProjection[] {
  const now = args.now ?? new Date();
  const maxDays = args.maxDays ?? 400;
  const inPlan = new Map(args.jobs.map((j) => [norm(j.jobId), j]));

  type Raw = { at: Date; kind: ProjectionEvent['kind']; ref: string; qty: number };
  const comps = new Map<string, {
    description?: string; uom?: string; onHand: number; opening: number;
    raw: Raw[]; unscheduled: Map<string, number>;
  }>();
  const comp = (code: string) => {
    let c = comps.get(code);
    if (!c) { c = { onHand: 0, opening: 0, raw: [], unscheduled: new Map() }; comps.set(code, c); }
    return c;
  };

  // 1. Demand of planned jobs — decides which codes are projected.
  for (const [jobId, job] of inPlan) {
    const lines = args.requirementsByJob.get(jobId) || args.requirementsByJob.get(job.jobId) || [];
    const start = toDate(job.start);
    for (const l of lines) {
      const code = norm(l.componentCode);
      const q = Math.max(0, Number(l.outstandingQty) || 0);
      if (!code || !q) continue;
      const c = comp(code);
      if (!c.uom && l.unitOfMeasure) c.uom = l.unitOfMeasure;
      if (start) c.raw.push({ at: start < now ? now : start, kind: 'demand', ref: jobId, qty: -q });
      else c.unscheduled.set(jobId, (c.unscheduled.get(jobId) || 0) + q);
    }
  }
  if (!comps.size) return [];

  // 2. Opening stock.
  for (const s of args.stock) {
    const c = comps.get(norm(s.code));
    if (!c) continue;
    c.onHand += Number(s.qtyOnHand) || 0;
    c.opening += (Number(s.qtyOnHand) || 0) - (Number(s.qtyAllocSO) || 0);
    if (!c.description && s.description) c.description = s.description;
    if (!c.uom && s.unitOfMeasure) c.uom = s.unitOfMeasure;
  }
  for (const [jobId, lines] of args.requirementsByJob) {
    if (inPlan.has(norm(jobId))) continue;
    for (const l of lines) {
      const c = comps.get(norm(l.componentCode));
      if (c) c.opening -= Math.max(0, Number(l.outstandingQty) || 0);
    }
  }

  // 3. Supply: PO receipts and planned jobs that make a component.
  for (const r of args.poReceipts) {
    const c = comps.get(norm(r.componentCode));
    const q = Number(r.outstandingQty) || 0;
    if (!c || q <= 0) continue;
    const d = toDate(r.promiseDate) || toDate(r.dueDate);
    c.raw.push({ at: d && d > now ? d : now, kind: 'po', ref: norm(r.poNumber) || 'PO', qty: q });
  }
  for (const [jobId, job] of inPlan) {
    const c = comps.get(norm(job.itemCode));
    const end = toDate(job.end);
    const q = Number(job.quantity) || 0;
    if (!c || !end || q <= 0) continue;
    c.raw.push({ at: end < now ? now : end, kind: 'output', ref: jobId, qty: q });
  }

  // 4. Walk events in time order.
  const out: ComponentProjection[] = [];
  for (const [code, c] of comps) {
    c.raw.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.qty < 0 ? 1 : 0) - (b.qty < 0 ? 1 : 0));
    let bal = c.opening;
    let min = bal;
    let firstShort: ComponentProjection['firstShort'];
    const events: ProjectionEvent[] = [];
    for (const e of c.raw) {
      bal += e.qty;
      events.push({ date: e.at.toISOString(), kind: e.kind, ref: e.ref, qty: round(e.qty), balance: round(bal) });
      if (bal < min) min = bal;
      if (!firstShort && e.qty < 0 && bal < -1e-9) {
        firstShort = { date: e.at.toISOString(), jobId: e.ref, shortQty: round(-bal) };
      }
    }

    // Daily end-of-day balances.
    const daily: ComponentProjection['daily'] = [];
    const last = c.raw.length ? c.raw[c.raw.length - 1].at : now;
    let i = 0, running = c.opening;
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let n = 0; n < maxDays && cursor <= last; n++) {
      const endOfDay = new Date(cursor.getTime() + 86400000);
      while (i < c.raw.length && c.raw[i].at < endOfDay) running += c.raw[i++].qty;
      daily.push({ day: dayKey(cursor), balance: round(running) });
      cursor.setDate(cursor.getDate() + 1);
    }
    if (!daily.length) daily.push({ day: dayKey(now), balance: round(c.opening) });

    out.push({
      code,
      description: c.description,
      unitOfMeasure: c.uom,
      opening: round(c.opening),
      onHand: round(c.onHand),
      events,
      unscheduledDemand: Array.from(c.unscheduled, ([jobId, qty]) => ({ jobId, qty: round(qty) })),
      minBalance: round(min),
      finalBalance: round(bal),
      firstShort,
      status: firstShort ? 'short' : 'ok',
      daily,
    });
  }

  return out.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'short' ? -1 : 1) ||
    (a.firstShort && b.firstShort ? a.firstShort.date.localeCompare(b.firstShort.date) : 0) ||
    a.code.localeCompare(b.code));
}
