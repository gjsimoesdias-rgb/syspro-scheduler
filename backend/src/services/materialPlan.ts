/**
 * Material availability — ONE formula for the scheduler, the /jobs/material-plan
 * route and the BOM-detail modal. Pure (no DB), so it is unit-tested directly.
 *
 * Model (checked against HFARMCompany1, 2026-09-30):
 *  - A job's need per component = its OUTSTANDING requirement from WipJobAllMat:
 *      required = (FixedQtyPerFlag = 'Y' ? FixedQtyPer : NetUnitQtyReqd × QtyToMake) × (1 + Scrap%)
 *      outstanding = AllocCompleted = 'Y' ? 0 : max(0, required − QtyIssued)
 *    (material already issued is no longer counted as needed).
 *  - Supply per component + warehouse = QtyOnHand − QtyAllocated (sales orders)
 *      − outstanding needs of open jobs NOT in this run
 *      + open PO receipts promised on/before the job's need date.
 *    InvWarehouse.QtyAllocatedWip is NOT subtracted: it already contains the
 *    run's own jobs, whose needs are consumed one by one below (subtracting both
 *    double-counts, and would take each job's own allocation from itself).
 *  - Jobs consume supply in order (schedule order when known, else the run's
 *    priority order), so later jobs see what earlier ones used.
 *  - A requirement line with a warehouse draws on that warehouse only; a line
 *    without one draws on the total across warehouses.
 */

export interface RequirementLine {
  jobId: string;
  componentCode: string;
  /** '' when unknown → uses the all-warehouse total. */
  warehouseCode: string;
  unitOfMeasure?: string;
  /** Still to be issued for this job. */
  outstandingQty: number;
}

export interface StockRow {
  code: string;
  warehouseCode: string;
  qtyOnHand: number;
  /** InvWarehouse.QtyAllocated — reserved for sales orders. */
  qtyAllocSO: number;
}

export interface PoReceipt {
  componentCode: string;
  warehouseCode?: string;
  promiseDate: Date | null;
  outstandingQty: number;
}

export interface PlanJob {
  jobId: string;
  itemCode?: string;
  releaseDate?: Date | string | null;
  dueDate?: Date | string | null;
}

export interface MaterialShortage {
  componentCode: string;
  requiredQty: number;
  availableQty: number;
  shortageQty: number;
  unitOfMeasure?: string;
}

export interface MaterialPlanResult {
  jobId: string;
  itemCode?: string;
  status: 'Materials' | 'Partial' | 'No Materials';
  available: boolean;
  shortages: MaterialShortage[];
}

const ANY = '*';
const norm = (s: unknown) => String(s ?? '').trim();
const key = (code: string, wh: string) => `${code}|${wh || ANY}`;
const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Need date = earlier of release and due date (now if neither is known). */
export const needDateOf = (job: PlanJob): Date => {
  const r = toDate(job.releaseDate);
  const d = toDate(job.dueDate);
  if (r && d) return r < d ? r : d;
  return r || d || new Date();
};

export function computeMaterialPlans(args: {
  jobs: PlanJob[];
  /** Outstanding needs of ALL open jobs (run jobs and others), by jobId. */
  requirementsByJob: Map<string, RequirementLine[]>;
  stock: StockRow[];
  poReceipts: PoReceipt[];
  /** Job ids in consumption order; jobs not listed follow in their given order. */
  order?: string[];
}): Map<string, MaterialPlanResult> {
  const { jobs, requirementsByJob, stock, poReceipts } = args;
  const result = new Map<string, MaterialPlanResult>();
  if (!jobs.length) return result;

  // Stock per code|warehouse and per code (all warehouses).
  const base = new Map<string, number>();
  const add = (k: string, q: number) => base.set(k, (base.get(k) || 0) + q);
  for (const s of stock) {
    const code = norm(s.code);
    if (!code) continue;
    const net = (Number(s.qtyOnHand) || 0) - (Number(s.qtyAllocSO) || 0);
    add(key(code, norm(s.warehouseCode)), net);
    add(key(code, ''), net);
  }

  // Needs of open jobs outside this run are already spoken for.
  const inRun = new Set(jobs.map((j) => norm(j.jobId)));
  for (const [jobId, lines] of requirementsByJob) {
    if (inRun.has(norm(jobId))) continue;
    for (const l of lines) {
      const code = norm(l.componentCode);
      const q = Math.max(0, Number(l.outstandingQty) || 0);
      if (!code || !q) continue;
      add(key(code, norm(l.warehouseCode)), -q);
      add(key(code, ''), -q);
    }
  }

  // Consumption order.
  const pos = new Map((args.order || []).map((id, i) => [norm(id), i]));
  const ordered = args.order
    ? [...jobs].sort((a, b) => (pos.get(norm(a.jobId)) ?? Infinity) - (pos.get(norm(b.jobId)) ?? Infinity))
    : jobs;

  const consumed = new Map<string, number>();
  const consume = (k: string, q: number) => consumed.set(k, (consumed.get(k) || 0) + q);

  for (const job of ordered) {
    const jobId = norm(job.jobId);
    const needDate = needDateOf(job);

    // Merge duplicate lines for the same component + warehouse.
    const merged = new Map<string, { code: string; wh: string; qty: number; uom?: string }>();
    for (const l of requirementsByJob.get(jobId) || requirementsByJob.get(job.jobId) || []) {
      const code = norm(l.componentCode);
      if (!code) continue;
      const wh = norm(l.warehouseCode);
      const k = key(code, wh);
      const m = merged.get(k) || { code, wh, qty: 0, uom: l.unitOfMeasure };
      m.qty += Math.max(0, Number(l.outstandingQty) || 0);
      merged.set(k, m);
    }

    let ok = 0, partial = 0, short = 0;
    const shortages: MaterialShortage[] = [];

    for (const [k, line] of merged) {
      const incoming = poReceipts.reduce((sum, r) => {
        if (norm(r.componentCode) !== line.code) return sum;
        const rWh = norm(r.warehouseCode);
        if (line.wh && rWh && rWh !== line.wh) return sum;
        if (r.promiseDate && r.promiseDate > needDate) return sum; // arrives too late
        return sum + (Number(r.outstandingQty) || 0);
      }, 0);

      const required = line.qty;
      const availableQty = Math.max(0, (base.get(k) || 0) + incoming - (consumed.get(k) || 0));
      // Consume from both the warehouse bucket and the all-warehouse total.
      consume(k, required);
      if (line.wh) consume(key(line.code, ''), required);

      if (required <= 0 || availableQty >= required) { ok++; continue; }
      if (availableQty > 0) partial++; else short++;
      shortages.push({
        componentCode: line.code,
        requiredQty: required,
        availableQty,
        shortageQty: required - availableQty,
        unitOfMeasure: line.uom,
      });
    }

    const status: MaterialPlanResult['status'] =
      short === 0 && partial === 0 ? 'Materials' : ok === 0 && partial === 0 ? 'No Materials' : 'Partial';
    result.set(jobId, { jobId, itemCode: job.itemCode, status, available: status === 'Materials', shortages });
  }

  return result;
}
