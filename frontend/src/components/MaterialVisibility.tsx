/**
 * Projected inventory by day — every component the plan uses, time-phased:
 * opening stock, PO receipts on their promise dates, planned sub-assembly
 * output at job end, and demand at each job's planned start
 * (backend: services/inventoryProjection.ts).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Job, JobSchedule } from '../types';
import { inventoryService, ComponentProjection } from '../services/api';
import { planJobsFrom, planKeyOf } from '../utils/planJobs';
import './MaterialVisibility.css';

interface MaterialVisibilityProps {
  jobSchedules: JobSchedule[];
  jobs: Job[];
}

const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const fmtDay = (s: string) => { const [, m, d] = s.split('-'); return `${d}/${m}`; };
const fmtQty = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const KIND_LABEL = { po: 'PO receipt', output: 'Job output', demand: 'Job demand' } as const;

/** Small step chart of end-of-day balance; red below zero. */
function Sparkline({ daily }: { daily: ComponentProjection['daily'] }) {
  const w = 140, h = 28;
  if (!daily.length) return <svg width={w} height={h} className="mat-spark" aria-hidden />;
  // One day only: draw it as a flat line across the cell.
  const series = daily.length === 1 ? [daily[0], daily[0]] : daily;
  const vals = series.map((d) => d.balance);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (series.length - 1)) * (w - 2) + 1;
  const y = (v: number) => h - 2 - ((v - lo) / span) * (h - 4);
  let path = `M${x(0)},${y(vals[0])}`;
  for (let i = 1; i < vals.length; i++) path += ` H${x(i)} V${y(vals[i])}`;
  return (
    <svg width={w} height={h} className="mat-spark" role="img"
      aria-label={`Balance from ${fmtQty(vals[0])} to ${fmtQty(vals[vals.length - 1])}`}>
      <title>{`${fmtDay(daily[0].day)} → ${fmtDay(daily[daily.length - 1].day)}: low ${fmtQty(Math.min(...vals))}`}</title>
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} className="mat-spark-zero" />
      <path d={path} className={Math.min(...vals) < 0 ? 'mat-spark-line short' : 'mat-spark-line'} />
    </svg>
  );
}

export default function MaterialVisibility({ jobSchedules, jobs }: MaterialVisibilityProps) {
  const [data, setData] = useState<ComponentProjection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shortOnly, setShortOnly] = useState(false);
  const [filter, setFilter] = useState('');

  const planJobs = useMemo(() => planJobsFrom(jobs, jobSchedules), [jobs, jobSchedules]);
  const planKey = useMemo(() => planKeyOf(planJobs), [planJobs]);

  useEffect(() => {
    if (!planJobs.length) { setData([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      inventoryService.projection(planJobs)
        .then((r) => { if (!cancelled) setData(r.components || []); })
        .catch((e) => { if (!cancelled) setError(e?.response?.data?.error || e?.message || 'Failed to load projection'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data || []).filter((c) =>
      (!shortOnly || c.status === 'short') &&
      (!f || c.code.toLowerCase().includes(f) || (c.description || '').toLowerCase().includes(f) ||
        c.events.some((e) => e.ref.toLowerCase().includes(f))));
  }, [data, shortOnly, filter]);

  const shortCount = (data || []).filter((c) => c.status === 'short').length;
  const supplyOf = (c: ComponentProjection) => c.events.filter((e) => e.qty > 0).reduce((s, e) => s + e.qty, 0);
  const demandOf = (c: ComponentProjection) => -c.events.filter((e) => e.qty < 0).reduce((s, e) => s + e.qty, 0);

  return (
    <div className="material-visibility">
      <div className="mat-header">
        <div>
          <h3>Projected inventory</h3>
          <div className="mat-sub">
            Stock on hand less sales-order allocations and open jobs outside the plan, then PO receipts on their
            promise dates, sub-assembly output at job end, and each job's needs at its planned start.
          </div>
        </div>
        <div className="mat-stats">
          <span className="stat-item error">{shortCount} short</span>
          <span className="stat-item success">{(data?.length || 0) - shortCount} OK</span>
          <span className="stat-item neutral">{data?.length || 0} components</span>
        </div>
      </div>

      <div className="mat-toolbar">
        <input type="search" placeholder="Filter by stock code, description, job or PO" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="Filter components" />
        <label><input type="checkbox" checked={shortOnly} onChange={(e) => setShortOnly(e.target.checked)} /> Short only</label>
        {loading && <span className="mat-muted">Loading…</span>}
      </div>

      {error && <div className="material-alert">{error}</div>}
      {!error && data && data.length === 0 && !loading && (
        <div className="material-alert">No component demand in this plan.</div>
      )}

      {rows.length > 0 && (
        <div className="material-table">
          <div className="table-header mat-grid">
            <div>Material</div>
            <div>Description</div>
            <div className="text-right">On hand</div>
            <div className="text-right" title="On hand − sales-order allocations − needs of open jobs outside the plan">Opening</div>
            <div className="text-right">Supply</div>
            <div className="text-right">Demand</div>
            <div className="text-right">Lowest</div>
            <div className="text-right">End</div>
            <div>First short</div>
            <div>Balance by day</div>
          </div>
          <div className="table-body">
            {rows.map((c) => (
              <React.Fragment key={c.code}>
                <div className={`table-row mat-grid ${c.status === 'short' ? 'row-shortage' : 'row-sufficient'} ${expanded === c.code ? 'row-expanded' : ''}`}
                  onClick={() => setExpanded(expanded === c.code ? null : c.code)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(expanded === c.code ? null : c.code); } }}
                  aria-expanded={expanded === c.code}>
                  <div className="col-code"><span className="expand-icon">{expanded === c.code ? '▾' : '▸'}</span>{c.code}</div>
                  <div className="col-desc" title={c.description}>{c.description || '—'}</div>
                  <div className="text-right col-num">{fmtQty(c.onHand)}</div>
                  <div className={`text-right col-num ${c.opening < 0 ? 'col-negative' : ''}`}>{fmtQty(c.opening)}</div>
                  <div className="text-right col-num">{fmtQty(supplyOf(c))}</div>
                  <div className="text-right col-num">{fmtQty(demandOf(c))}</div>
                  <div className={`text-right col-num ${c.minBalance < 0 ? 'col-negative' : ''}`}>{fmtQty(c.minBalance)}</div>
                  <div className={`text-right col-num ${c.finalBalance < 0 ? 'col-negative' : ''}`}>{fmtQty(c.finalBalance)}</div>
                  <div className="col-stockout">
                    {c.firstShort ? <><span title={c.firstShort.jobId}>{c.firstShort.jobId.replace(/^0+(?=\d)/, '')}</span> · {fmtDate(c.firstShort.date)}<br /><span className="mat-muted">short {fmtQty(c.firstShort.shortQty)} {c.unitOfMeasure || ''}</span></> : '—'}
                  </div>
                  <div><Sparkline daily={c.daily} /></div>
                </div>
                {expanded === c.code && (
                  <div className="mat-detail">
                    <div className="mat-detail-header mat-detail-grid">
                      <div>Date</div><div>Event</div><div>Job / PO</div>
                      <div className="text-right">Qty</div><div className="text-right">Balance</div>
                    </div>
                    <div className="mat-detail-row mat-detail-grid">
                      <div>—</div><div>Opening</div><div className="mat-muted">on hand {fmtQty(c.onHand)}</div>
                      <div /><div className={`text-right ${c.opening < 0 ? 'col-negative' : ''}`}>{fmtQty(c.opening)}</div>
                    </div>
                    {c.events.map((e, i) => (
                      <div key={i} className={`mat-detail-row mat-detail-grid ${e.balance < 0 ? 'detail-negative' : ''}`}>
                        <div>{fmtDate(e.date)}</div>
                        <div className={`mat-kind mat-kind-${e.kind}`}>{KIND_LABEL[e.kind]}</div>
                        <div>{e.ref}</div>
                        <div className="text-right">{e.qty > 0 ? '+' : ''}{fmtQty(e.qty)}</div>
                        <div className={`text-right ${e.balance < 0 ? 'col-negative' : ''}`}>{fmtQty(e.balance)}</div>
                      </div>
                    ))}
                    {c.unscheduledDemand.length > 0 && (
                      <div className="mat-unscheduled">
                        Not scheduled, so not in the timeline: {c.unscheduledDemand.map((u) => `${u.jobId} (${fmtQty(u.qty)})`).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
