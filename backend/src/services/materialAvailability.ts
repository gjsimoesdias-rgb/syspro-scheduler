/**
 * FMAD — First Material Availability Date per job (LYNQ grid column).
 *
 * The earliest date every component a job still needs is available to it.
 * Pure (no DB) and unit-tested. Per stock code (all warehouses together):
 *   supply = free stock now (QtyOnHand − sales-order allocations)
 *          + open PO receipts at their promise date (overdue/undated → now)
 * Jobs claim supply in order of need (planned start, else due date), so two
 * jobs can't both count the same stock. A component's date is when the
 * job's quantity is covered; when known supply runs out, today + the
 * stock code's lead time (InvMaster.LeadTime), or no date if none is set.
 * The job's FMAD is the latest of its components' dates.
 */
import type { RequirementLine, StockRow, PoReceipt } from './materialPlan';

export interface FmadJob {
  jobId: string;
  start?: Date | string | null;
  dueDate?: Date | string | null;
}

export type FmadStatus = 'in-stock' | 'on-order' | 'lead-time' | 'no-supply' | 'no-materials';

export interface JobFmad {
  /** ISO date-time, or null when no materials are needed / no supply is known. */
  fmad: string | null;
  status: FmadStatus;
  /** Component that sets the date (latest / missing). */
  limiting?: string;
  components: number;
}

const norm = (s: unknown) => String(s ?? '').trim();
const toMs = (v: unknown): number | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};
const RANK: Record<FmadStatus, number> = { 'no-materials': 0, 'in-stock': 1, 'on-order': 2, 'lead-time': 3, 'no-supply': 4 };

export function firstMaterialAvailability(args: {
  jobs: FmadJob[];
  requirementsByJob: Map<string, RequirementLine[]>;
  stock: StockRow[];
  poReceipts: PoReceipt[];
  leadTimeDays?: Map<string, number>;
  now?: Date;
}): Record<string, JobFmad> {
  const now = (args.now ?? new Date()).getTime();
  const DAY = 86400000;

  // Supply lots per component, in date order.
  type Lot = { at: number; qty: number; kind: 'stock' | 'po' };
  const lots = new Map<string, Lot[]>();
  const lotsOf = (code: string) => {
    let l = lots.get(code);
    if (!l) { l = []; lots.set(code, l); }
    return l;
  };
  const free = new Map<string, number>();
  for (const s of args.stock) {
    const code = norm(s.code);
    free.set(code, (free.get(code) || 0) + (Number(s.qtyOnHand) || 0) - (Number(s.qtyAllocSO) || 0));
  }
  free.forEach((qty, code) => { if (qty > 0) lotsOf(code).push({ at: now, qty, kind: 'stock' }); });
  for (const p of args.poReceipts) {
    const qty = Number(p.outstandingQty) || 0;
    if (qty <= 0) continue;
    const at = Math.max(now, toMs(p.promiseDate) ?? now);
    lotsOf(norm(p.componentCode)).push({ at, qty, kind: 'po' });
  }
  lots.forEach((l) => l.sort((a, b) => a.at - b.at || (a.kind === 'stock' ? -1 : 1)));

  // Jobs in order of need.
  const order = args.jobs
    .map((j) => ({ jobId: norm(j.jobId), need: toMs(j.start) ?? toMs(j.dueDate) ?? Number.MAX_SAFE_INTEGER }))
    .filter((j) => j.jobId)
    .sort((a, b) => a.need - b.need || a.jobId.localeCompare(b.jobId));

  const out: Record<string, JobFmad> = {};
  for (const { jobId } of order) {
    const need = new Map<string, number>();
    for (const r of args.requirementsByJob.get(jobId) || []) {
      const qty = Number(r.outstandingQty) || 0;
      if (qty > 0) need.set(norm(r.componentCode), (need.get(norm(r.componentCode)) || 0) + qty);
    }
    if (!need.size) { out[jobId] = { fmad: null, status: 'no-materials', components: 0 }; continue; }

    let worst: { at: number | null; status: FmadStatus; code: string } = { at: now, status: 'in-stock', code: '' };
    need.forEach((qty, code) => {
      let left = qty;
      let at = now;
      let status: FmadStatus = 'in-stock';
      for (const lot of lots.get(code) || []) {
        if (left <= 1e-9) break;
        if (lot.qty <= 1e-9) continue;
        const take = Math.min(lot.qty, left);
        lot.qty -= take;
        left -= take;
        at = Math.max(at, lot.at);
        if (lot.kind === 'po') status = 'on-order';
      }
      let atOrNull: number | null = at;
      if (left > 1e-9) {
        const lt = args.leadTimeDays?.get(code) ?? 0;
        if (lt > 0) { atOrNull = Math.max(at, now + lt * DAY); status = 'lead-time'; }
        else { atOrNull = null; status = 'no-supply'; }
      }
      // Latest date wins (no date = never = latest); same date → worse status.
      const key = atOrNull ?? Infinity;
      const worstKey = worst.at ?? Infinity;
      if (key > worstKey || (key === worstKey && RANK[status] > RANK[worst.status])) worst = { at: atOrNull, status, code };
    });
    out[jobId] = {
      fmad: worst.at === null ? null : new Date(worst.at).toISOString(),
      status: worst.status,
      limiting: worst.code || undefined,
      components: need.size,
    };
  }
  return out;
}
