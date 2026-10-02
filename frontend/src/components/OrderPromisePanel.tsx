/**
 * OrderPromisePanel — Capable-to-Promise (CTP) simulation.
 *
 * "If we accept this order today, what date can we promise?"
 * Builds a prospective routing (manually or copied from an existing job),
 * sends it to POST /api/schedule/ctp, and shows the earliest completion
 * against the committed load of the latest saved schedule. Read-only —
 * nothing is written to the live schedule.
 *
 * MASTER JOBS: choosing a master job in "copy routing" also pulls in its
 * sub-jobs. Sub-job legs run in parallel (sharing capacity) and the master
 * routing starts only after the last sub-job finishes — mirroring how the
 * scheduling engine enforces SYSPRO master/sub precedence.
 */
import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2, CalendarCheck, Copy, GitBranch, X, Search, PackageSearch } from 'lucide-react';
import { apiClient, apiErrorMessage } from '../services/api';
import type { Job, Resource } from '../types';
import './OrderPromisePanel.css';

/** 1200.37 → "20h 0m"; 45 → "45m". */
const fmtMinutes = (m: number): string => {
  const t = Math.round(Number(m) || 0);
  return t >= 60 ? `${Math.floor(t / 60)}h ${t % 60}m` : `${t}m`;
};

interface OpRow {
  id: number;
  workcentreId: string;
  setupMinutes: string;
  runMinutes: string;
  description: string;
}

interface SubLeg {
  id: number;
  label: string;
  operations: Array<{ workcentreId: string; setupMinutes: number; runMinutes: number; description?: string }>;
}

interface CtpPlacement {
  sequence: number;
  workcentreId: string;
  resourceId: string;
  resourceName?: string;
  description?: string;
  leg?: string;
  start: string;
  end: string;
  setupMinutes: number;
  runMinutes: number;
  waitMinutes: number;
}

interface CtpResponse {
  feasible: boolean;
  promiseDate: string | null;
  placements: CtpPlacement[];
  message?: string;
  assumptions: string[];
  onTime?: boolean;
  masterStart?: string;
  legEnds?: Array<{ leg: string; end: string }>;
}

interface Props {
  resources: Resource[];
  jobs: Job[];
}

let nextRowId = 1;

const fmtDT = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

const jobToOps = (job: Job) =>
  [...(job.operations || [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((op) => ({
      workcentreId: op.workcentreId,
      setupMinutes: Math.max(0, op.setupTime ?? 0),
      runMinutes: Math.max(1, op.duration ?? 60),
      description: (op as any).description || `Op ${op.sequence}`,
    }));

const OrderPromisePanel: React.FC<Props> = ({ resources, jobs }) => {
  const workcentres = useMemo(
    () => Array.from(new Set(resources.map((r) => r.worcentreId))).sort(),
    [resources]
  );

  const [rows, setRows] = useState<OpRow[]>([
    { id: nextRowId++, workcentreId: '', setupMinutes: '15', runMinutes: '60', description: '' },
  ]);
  const [subLegs, setSubLegs] = useState<SubLeg[]>([]);
  const [desiredDate, setDesiredDate] = useState('');
  const [copyFromJob, setCopyFromJob] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CtpResponse | null>(null);

  // ── SYSPRO stock-code quoting (structures & routings, not WIP jobs) ──
  const [stockQuery, setStockQuery] = useState('');
  const [stockResults, setStockResults] = useState<Array<{ stockCode: string; description: string; hasRouting: number }>>([]);
  const [stockSearching, setStockSearching] = useState(false);
  const [selectedStock, setSelectedStock] = useState<{ stockCode: string; description: string } | null>(null);
  const [stockQty, setStockQty] = useState('1');
  const [loadingRouting, setLoadingRouting] = useState(false);
  const [routingWarnings, setRoutingWarnings] = useState<string[]>([]);

  const searchStock = async () => {
    const q = stockQuery.trim();
    if (q.length < 2) {
      toast.error('Type at least 2 characters to search stock codes');
      return;
    }
    try {
      setStockSearching(true);
      const res = await apiClient.get('/schedule/ctp/stock-search', { params: { q } });
      setStockResults(res.data?.items || []);
      if (!(res.data?.items || []).length) toast('No stock codes match', { icon: '' });
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Stock code search failed'));
    } finally {
      setStockSearching(false);
    }
  };

  const loadStockRouting = async (stockCode: string, qty: number) => {
    try {
      setLoadingRouting(true);
      const res = await apiClient.get(`/schedule/ctp/stock-routing/${encodeURIComponent(stockCode)}`, {
        params: { quantity: qty },
      });
      const data = res.data;
      setRows(
        (data.operations || []).map((op: any) => ({
          id: nextRowId++,
          workcentreId: op.workcentreId,
          setupMinutes: String(op.setupMinutes),
          runMinutes: String(op.runMinutes),
          description: op.description || '',
        }))
      );
      setSubLegs(
        (data.subJobs || []).map((sj: any) => ({ id: nextRowId++, label: sj.label, operations: sj.operations }))
      );
      setRoutingWarnings(data.warnings || []);
      setSelectedStock({ stockCode: data.stockCode, description: data.description });
      setCopyFromJob('');
      setStockResults([]);
      setResult(null);
      toast.success(
        `${data.stockCode}: ${data.operations.length} routing ops` +
          ((data.subJobs || []).length ? ` + ${data.subJobs.length} made-in sub-assembl${data.subJobs.length === 1 ? 'y' : 'ies'}` : '')
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, `No routing found for ${stockCode}`));
    } finally {
      setLoadingRouting(false);
    }
  };

  const updateRow = (id: number, patch: Partial<OpRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { id: nextRowId++, workcentreId: '', setupMinutes: '0', runMinutes: '60', description: '' },
    ]);

  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));

  const copyRouting = (jobId: string) => {
    setCopyFromJob(jobId);
    setSelectedStock(null);
    setRoutingWarnings([]);
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) return;

    // Master job? Pull the whole family INCLUDING nested levels (sub of sub).
    // Each DIRECT sub-job becomes one leg; its own sub-jobs are serialised into
    // that leg in build order (deepest first) — matching how the CTP backend
    // explodes multi-level BOM structures.
    const directSubs = jobs.filter((j) => j.masterJobId === job.jobId && j.jobId !== job.jobId);
    const isMaster = !!job.isMasterJob || directSubs.length > 0;

    if (job.operations?.length) {
      setRows(
        jobToOps(job).map((op) => ({
          id: nextRowId++,
          workcentreId: op.workcentreId,
          setupMinutes: String(op.setupMinutes),
          runMinutes: String(op.runMinutes),
          description: op.description || '',
        }))
      );
    }

    if (isMaster && directSubs.length > 0) {
      // Post-order traversal: children's ops before the node's own ops.
      const subtreeOps = (
        root: Job,
        seen: Set<string>
      ): Array<{ workcentreId: string; setupMinutes: number; runMinutes: number; description?: string }> => {
        if (seen.has(root.jobId)) return [];
        seen.add(root.jobId);
        const children = jobs.filter((j) => j.masterJobId === root.jobId && j.jobId !== root.jobId);
        const acc: Array<{ workcentreId: string; setupMinutes: number; runMinutes: number; description?: string }> = [];
        for (const child of children) acc.push(...subtreeOps(child, seen));
        acc.push(...jobToOps(root).map((op) => ({ ...op, description: `${root.jobId} · ${op.description || ''}` })));
        return acc;
      };

      const seen = new Set<string>([job.jobId]);
      const legs = directSubs
        .map((sj) => {
          const before = seen.size;
          const operations = subtreeOps(sj, seen);
          const nested = seen.size - before - 1; // jobs beyond the direct sub itself
          return {
            id: nextRowId++,
            label: nested > 0 ? `${sj.jobId} (+${nested} nested)` : sj.jobId,
            operations,
          };
        })
        .filter((l) => l.operations.length > 0);

      setSubLegs(legs);
      const totalFamily = seen.size - 1; // excludes the master itself
      toast.success(
        `Master job family copied: ${job.jobId} + ${totalFamily} sub-job${totalFamily === 1 ? '' : 's'}` +
          (totalFamily > directSubs.length ? ' (nested levels included)' : '')
      );
    } else {
      setSubLegs([]);
      toast.success(`Routing copied from ${jobId} (${job.operations?.length || 0} operations)`);
    }
  };

  const removeSubLeg = (id: number) => setSubLegs((prev) => prev.filter((l) => l.id !== id));

  const runSimulation = async () => {
    const operations = rows
      .filter((r) => r.workcentreId)
      .map((r) => ({
        workcentreId: r.workcentreId,
        setupMinutes: Math.max(0, Number(r.setupMinutes) || 0),
        runMinutes: Math.max(1, Number(r.runMinutes) || 1),
        ...(r.description ? { description: r.description } : {}),
      }));
    if (operations.length === 0) {
      toast.error('Add at least one operation with a workcentre');
      return;
    }
    try {
      setRunning(true);
      setResult(null);
      const res = await apiClient.post('/schedule/ctp', {
        operations,
        ...(subLegs.length > 0
          ? { subJobs: subLegs.map((l) => ({ label: l.label, operations: l.operations })) }
          : {}),
        ...(desiredDate ? { desiredDueDate: new Date(`${desiredDate}T23:59:59`).toISOString() } : {}),
      });
      setResult(res.data);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'CTP simulation failed'));
    } finally {
      setRunning(false);
    }
  };

  const hasLegs = (result?.placements || []).some((p) => p.leg);

  return (
    <div className="ctp-panel">
      <div className="ctp-config">
        <div className="ctp-header">
          <h3><CalendarCheck size={15} /> Order Promising (CTP)</h3>
          <p>
            Simulate a prospective order against the committed load of the latest saved schedule.
            Read-only — the live schedule is never modified.
          </p>
        </div>

        <div className="ctp-stock">
          <div className="ctp-stock-title">
            <PackageSearch size={13} aria-hidden="true" /> Quote a stock code (SYSPRO routing)
          </div>
          <div className="ctp-stock-row">
            <input
              type="text"
              placeholder="Search stock code or description…"
              value={stockQuery}
              onChange={(e) => setStockQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchStock()}
              aria-label="Stock code search"
            />
            <button className="btn btn-sm" onClick={searchStock} disabled={stockSearching}>
              <Search size={13} /> {stockSearching ? '…' : 'Search'}
            </button>
            <label className="ctp-stock-qty">
              Qty
              <input
                type="number"
                min={1}
                value={stockQty}
                onChange={(e) => {
                  setStockQty(e.target.value);
                }}
                onBlur={() => {
                  const qty = Math.max(1, Number(stockQty) || 1);
                  if (selectedStock) loadStockRouting(selectedStock.stockCode, qty);
                }}
                aria-label="Quantity"
              />
            </label>
          </div>
          {stockResults.length > 0 && (
            <div className="ctp-stock-results">
              {stockResults.map((r) => (
                <button
                  key={r.stockCode}
                  className="ctp-stock-result"
                  disabled={!r.hasRouting || loadingRouting}
                  title={r.hasRouting ? 'Load routing from SYSPRO' : 'No routing in BomOperations'}
                  onClick={() => loadStockRouting(r.stockCode, Math.max(1, Number(stockQty) || 1))}
                >
                  <span className="mono">{r.stockCode}</span>
                  <span className="ctp-stock-desc">{r.description}</span>
                  {!r.hasRouting && <span className="ctp-no-routing">no routing</span>}
                </button>
              ))}
            </div>
          )}
          {selectedStock && (
            <div className="ctp-stock-selected">
              Quoting <strong>{selectedStock.stockCode}</strong>
              {selectedStock.description ? ` — ${selectedStock.description}` : ''} × {Math.max(1, Number(stockQty) || 1)}
              {loadingRouting && ' (loading routing…)'}
            </div>
          )}
          {routingWarnings.length > 0 && (
            <div className="ctp-stock-warnings">
              {routingWarnings.map((w, i) => (<div key={i}>ⓘ {w}</div>))}
            </div>
          )}
        </div>

        <div className="ctp-copy-row">
          <Copy size={13} aria-hidden="true" />
          <select
            value={copyFromJob}
            onChange={(e) => e.target.value && copyRouting(e.target.value)}
            aria-label="Copy routing from job"
          >
            <option value="">Copy routing from an existing job…</option>
            {jobs.map((j) => (
              <option key={j.jobId} value={j.jobId}>
                {j.isMasterJob ? '★ ' : j.isSubJob ? '↳ ' : ''}{j.jobId} — {j.itemCode} ({j.operations?.length || 0} ops)
              </option>
            ))}
          </select>
        </div>

        {subLegs.length > 0 && (
          <div className="ctp-sublegs">
            <div className="ctp-sublegs-title">
              <GitBranch size={13} aria-hidden="true" /> Sub-jobs (run in parallel, before the master)
            </div>
            {subLegs.map((leg) => (
              <div className="ctp-subleg" key={leg.id}>
                <span className="ctp-subleg-label">{leg.label}</span>
                <span className="ctp-subleg-meta">
                  {leg.operations.length} ops ·{' '}
                  {leg.operations.reduce((s, o) => s + o.setupMinutes + o.runMinutes, 0)} min
                </span>
                <button
                  className="ctp-row-delete"
                  onClick={() => removeSubLeg(leg.id)}
                  title={`Remove ${leg.label} from the simulation`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="ctp-sublegs-hint">
              The master routing below starts when the last sub-job finishes (SYSPRO master/sub precedence).
            </div>
          </div>
        )}

        <div className="ctp-ops">
          <div className="ctp-ops-head">
            <span>#</span><span>{subLegs.length > 0 ? 'Master workcentre' : 'Workcentre'}</span><span>Setup (min)</span><span>Run (min)</span><span>Description</span><span />
          </div>
          {rows.map((row, i) => (
            <div className="ctp-ops-row" key={row.id}>
              <span className="ctp-seq">{i + 1}</span>
              <select
                value={row.workcentreId}
                onChange={(e) => updateRow(row.id, { workcentreId: e.target.value })}
                aria-label={`Operation ${i + 1} workcentre`}
              >
                <option value="">Select…</option>
                {workcentres.map((wc) => (
                  <option key={wc} value={wc}>{wc}</option>
                ))}
              </select>
              <input
                type="number" min={0}
                value={row.setupMinutes}
                onChange={(e) => updateRow(row.id, { setupMinutes: e.target.value })}
                aria-label={`Operation ${i + 1} setup minutes`}
              />
              <input
                type="number" min={1}
                value={row.runMinutes}
                onChange={(e) => updateRow(row.id, { runMinutes: e.target.value })}
                aria-label={`Operation ${i + 1} run minutes`}
              />
              <input
                type="text"
                value={row.description}
                placeholder="optional"
                onChange={(e) => updateRow(row.id, { description: e.target.value })}
                aria-label={`Operation ${i + 1} description`}
              />
              <button
                className="ctp-row-delete"
                onClick={() => removeRow(row.id)}
                disabled={rows.length === 1}
                title="Remove operation"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button className="btn btn-sm" onClick={addRow}>
            <Plus size={13} /> Add operation
          </button>
        </div>

        <div className="ctp-run-row">
          <div className="ctp-field">
            <span>Customer requested date (optional)</span>
            <input type="date" value={desiredDate} onChange={(e) => setDesiredDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={runSimulation} disabled={running}>
            {running ? 'Simulating…' : 'Compute promise date'}
          </button>
        </div>
      </div>

      <div className="ctp-result">
        {!result && !running && (
          <div className="ctp-result-empty">
            Define the routing and compute to see the earliest promisable delivery date.
          </div>
        )}
        {running && <div className="ctp-result-empty">Running simulation…</div>}
        {result && !result.feasible && (
          <div className="ctp-banner infeasible">
            ✗ Not promisable — {result.message || 'no capacity found'}
          </div>
        )}
        {result && result.feasible && result.promiseDate && (
          <>
            <div className={`ctp-banner ${result.onTime === false ? 'late' : 'ok'}`}>
              <div className="ctp-banner-main">
                Earliest promise date: <strong>{fmtDT(result.promiseDate)}</strong>
              </div>
              {result.masterStart && (
                <div className="ctp-banner-sub">
                  Sub-jobs complete → master starts {fmtDT(result.masterStart)}
                </div>
              )}
              {result.onTime !== undefined && (
                <div className="ctp-banner-sub">
                  {result.onTime
                    ? '✓ Meets the customer requested date'
                    : 'Later than the customer requested date'}
                </div>
              )}
            </div>
            {result.legEnds && result.legEnds.length > 0 && (
              <div className="ctp-legends">
                {result.legEnds.map((l) => (
                  <span className="ctp-legend-chip" key={l.leg}>
                    {l.leg}: done {fmtDT(l.end)}
                  </span>
                ))}
              </div>
            )}
            <table className="ctp-table">
              <thead>
                <tr>
                  {hasLegs && <th>Leg</th>}
                  <th>#</th><th>Workcentre</th><th>Resource</th><th>Start</th><th>End</th>
                  <th className="num">Setup</th><th className="num">Run</th><th className="num">Wait</th>
                </tr>
              </thead>
              <tbody>
                {result.placements.map((p, idx) => (
                  <tr key={`${p.leg || 'main'}-${p.sequence}-${idx}`} className={p.leg === 'Master' ? 'ctp-master-row' : ''}>
                    {hasLegs && <td className="ctp-leg-cell">{p.leg || '—'}</td>}
                    <td>{p.sequence}</td>
                    <td>{p.workcentreId}</td>
                    <td>{p.resourceName || p.resourceId}</td>
                    <td>{fmtDT(p.start)}</td>
                    <td>{fmtDT(p.end)}</td>
                    <td className="num">{fmtMinutes(p.setupMinutes)}</td>
                    <td className="num">{fmtMinutes(p.runMinutes)}</td>
                    <td className="num">{fmtMinutes(p.waitMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {result && result.assumptions.length > 0 && (
          <div className="ctp-assumptions">
            <strong>Assumptions</strong>
            <ul>
              {result.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default OrderPromisePanel;
