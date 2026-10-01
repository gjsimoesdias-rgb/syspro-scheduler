/**
 * Sales orders — every open SYSPRO order line pegged to stock on hand and the
 * plan's jobs, with on-time / late / short status (backend: services/salesPegging.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Job, JobSchedule } from '../types';
import { inventoryService, PeggedSoLine, SoPeggingResult } from '../services/api';
import { planJobsFrom, planKeyOf } from '../utils/planJobs';
import './MaterialVisibility.css';

interface Props { jobSchedules: JobSchedule[]; jobs: Job[] }

const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const fmtQty = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const shortJob = (id: string) => id.replace(/^0+(?=\d)/, '');
const STATUS: Record<PeggedSoLine['status'], { label: string; cls: string; title: string }> = {
  'on-time': { label: 'On time', cls: 'so-ok', title: 'Covered by stock and planned jobs that finish by the ship date' },
  late: { label: 'Late', cls: 'so-late', title: 'Covered, but the last supply arrives after the ship date' },
  unscheduled: { label: 'Not planned', cls: 'so-warn', title: 'Covered by a job the plan has not scheduled' },
  short: { label: 'Short', cls: 'so-short', title: 'Stock plus the jobs in the plan do not cover this line' },
};
const ORDER = { short: 0, late: 1, unscheduled: 2, 'on-time': 3 } as const;

export default function SalesOrderPegging({ jobSchedules, jobs }: Props) {
  const [data, setData] = useState<SoPeggingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'status' | 'ship'>('status');

  const planJobs = useMemo(() => planJobsFrom(jobs, jobSchedules), [jobs, jobSchedules]);
  const planKey = useMemo(() => planKeyOf(planJobs), [planJobs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      inventoryService.pegging(planJobs)
        .then((r) => { if (!cancelled) setData(r); })
        .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e?.message || 'Failed to load sales orders'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (data?.lines || []).filter((l) =>
      (!problemsOnly || l.status !== 'on-time') &&
      (!f || [l.salesOrder, l.customer, l.customerName, l.customerPo, l.stockCode, l.description]
        .some((v) => (v || '').toLowerCase().includes(f)) ||
        l.pegs.some((p) => (p.jobId || '').includes(f))));
    const ship = (l: PeggedSoLine) => (l.shipDate ? new Date(l.shipDate).getTime() : Infinity);
    return [...list].sort((a, b) =>
      (sortBy === 'status' ? ORDER[a.status] - ORDER[b.status] : 0) || ship(a) - ship(b) ||
      a.salesOrder.localeCompare(b.salesOrder) || a.line - b.line);
  }, [data, problemsOnly, filter, sortBy]);

  const c = data?.counts;
  return (
    <div className="material-visibility">
      <div className="mat-header">
        <div>
          <h3>Sales orders</h3>
          <div className="mat-sub">
            Open stocked order lines, earliest ship date first, take stock on hand and then the planned jobs that make the
            item in order of planned finish. Jobs raised for a specific order line go to that line first.
          </div>
        </div>
        {c && (
          <div className="mat-stats">
            <span className="stat-item error">{c.short} short</span>
            <span className="stat-item warning">{c.late} late</span>
            {c.unscheduled > 0 && <span className="stat-item warning">{c.unscheduled} not planned</span>}
            <span className="stat-item success">{c.onTime} on time</span>
            <span className="stat-item neutral">{c.lines} lines</span>
          </div>
        )}
      </div>

      <div className="mat-toolbar">
        <input type="search" placeholder="Filter by order, customer, PO, stock code or job" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="Filter order lines" />
        <label><input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Problems only</label>
        <label>Sort
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} style={{ marginLeft: 4 }}>
            <option value="status">Status, then ship date</option>
            <option value="ship">Ship date</option>
          </select>
        </label>
        {loading && <span className="mat-muted">Loading…</span>}
      </div>

      {error && <div className="material-alert">{error}</div>}
      {data?.warning && <div className="material-alert">{data.warning}</div>}
      {!error && data && data.lines.length === 0 && !loading && (
        <div className="material-alert">No open stocked sales-order lines in SYSPRO.</div>
      )}

      {rows.length > 0 && (
        <div className="material-table">
          <div className="table-header so-grid">
            <div>Order</div><div>Customer</div><div>Stock code</div><div>Description</div>
            <div className="text-right">Open qty</div><div>Ship date</div><div>Supplied by</div>
            <div>Available</div><div>Status</div>
          </div>
          <div className="table-body">
            {rows.map((l) => {
              const st = STATUS[l.status];
              return (
                <div key={`${l.salesOrder}-${l.line}`} className={`table-row so-grid ${l.status === 'short' || l.status === 'late' ? 'row-shortage' : ''}`}>
                  <div className="col-code" title={l.customerPo ? `Customer PO ${l.customerPo}` : undefined}>
                    {l.salesOrder.replace(/^0+(?=\d)/, '')}<span className="mat-muted"> /{l.line}</span>
                  </div>
                  <div className="col-desc" title={l.customer}>{l.customerName || l.customer || '—'}</div>
                  <div>{l.stockCode}</div>
                  <div className="col-desc" title={l.description}>{l.description || '—'}</div>
                  <div className="text-right col-num">{fmtQty(l.openQty)} <span className="mat-muted">{l.unitOfMeasure}</span></div>
                  <div>{fmtDate(l.shipDate)}</div>
                  <div className="so-pegs">
                    {l.pegs.map((p, i) => (
                      <span key={i} className={`so-peg ${p.source}`} title={p.source === 'job' ? `Job ${p.jobId}${p.direct ? ' — raised for this order' : ''}; ready ${fmtDate(p.availableAt)}` : 'Stock on hand'}>
                        {p.source === 'stock' ? 'Stock' : `Job ${shortJob(p.jobId!)}`}{p.direct ? ' ★' : ''} {fmtQty(p.qty)}
                      </span>
                    ))}
                    {l.shortQty > 0 && <span className="so-peg missing">Short {fmtQty(l.shortQty)}</span>}
                  </div>
                  <div>{fmtDate(l.availableAt)}</div>
                  <div>
                    <span className={`so-status ${st.cls}`} title={st.title}>{st.label}{l.daysLate > 0 ? ` +${l.daysLate}d` : ''}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
