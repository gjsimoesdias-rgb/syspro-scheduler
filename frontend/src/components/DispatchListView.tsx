/**
 * DispatchListView — per-resource work-to lists (dispatch lists).
 *
 * The operator-facing output every major APS ships: for each machine, the
 * ordered sequence of operations to run, with start/end times, setup/run
 * minutes, and job context. Printable for shop-floor distribution.
 */
import React, { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import type { Schedule, Job, Resource, OperationSchedule } from '../types';
import './DispatchListView.css';

interface Props {
  schedule: Schedule | null;
  resources: Resource[];
  jobs: Job[];
}

interface DispatchRow extends OperationSchedule {
  jobId: string;
  itemCode: string;
  jobDescription: string;
  quantity: number;
  /** Set by the engine for user-pinned and frozen-zone operations. */
  pinned?: boolean;
}

const fmtDT = (d: Date | string) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};

const DispatchListView: React.FC<Props> = ({ schedule, resources, jobs }) => {
  const [resourceFilter, setResourceFilter] = useState<string>('all');
  const [dayFilter, setDayFilter] = useState<string>(''); // '' = all days

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.jobId, j])), [jobs]);
  const resourceById = useMemo(() => new Map(resources.map((r) => [r.resourceId, r])), [resources]);

  // Flatten schedule → rows grouped per resource, ordered by start time.
  const byResource = useMemo(() => {
    const map = new Map<string, DispatchRow[]>();
    if (!schedule) return map;

    for (const js of schedule.jobSchedules || []) {
      const job = jobById.get(js.jobId);
      for (const os of js.operationSchedules || []) {
        if (!os.resourceId) continue;
        if (resourceFilter !== 'all' && os.resourceId !== resourceFilter) continue;
        if (dayFilter) {
          const start = new Date(os.plannedStartDate);
          const dayStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
          if (dayStr !== dayFilter) continue;
        }
        const list = map.get(os.resourceId) ?? [];
        map.set(os.resourceId, list);
        list.push({
          ...os,
          jobId: js.jobId,
          itemCode: job?.itemCode || '—',
          jobDescription: job?.description || '',
          quantity: job?.quantity ?? 0,
        });
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime());
    }
    return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }, [schedule, jobById, resourceFilter, dayFilter]);

  const totalOps = useMemo(
    () => Array.from(byResource.values()).reduce((s, l) => s + l.length, 0),
    [byResource]
  );

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return;
    const now = new Date().toLocaleString();
    const sections = Array.from(byResource.entries())
      .map(([resourceId, rows]) => {
        const res = resourceById.get(resourceId);
        const body = rows
          .map(
            (r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${r.jobId}</td>
            <td>${r.opId}</td>
            <td>${r.itemCode}</td>
            <td>${r.jobDescription}</td>
            <td>${r.quantity || ''}</td>
            <td>${fmtDT(r.plannedStartDate)}</td>
            <td>${fmtDT(r.plannedEndDate)}</td>
            <td class="num">${r.setupTime || 0}</td>
            <td class="num">${r.runTime || 0}</td>
            <td>${r.pinned ? 'PINNED' : ''}${r.isOvertimeSlot ? ' OT' : ''}</td>
            <td class="sig"></td>
          </tr>`
          )
          .join('');
        return `
        <h2>${res?.name || resourceId} <span class="wc">(${res?.worcentreId || ''})</span></h2>
        <table>
          <thead>
            <tr>
              <th>#</th><th>Job</th><th>Op</th><th>Item</th><th>Description</th><th>Qty</th>
              <th>Start</th><th>End</th><th>Setup (min)</th><th>Run (min)</th><th>Flags</th><th>Done ✓</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>`;
      })
      .join('');

    win.document.write(`<!DOCTYPE html>
<html><head><title>Dispatch List — ${now}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #111; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .meta { color: #555; margin-bottom: 16px; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 2px solid #333; padding-bottom: 3px; page-break-after: avoid; }
  h2 .wc { font-weight: 400; color: #666; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #999; padding: 3px 6px; text-align: left; }
  th { background: #eee; font-size: 10px; text-transform: uppercase; }
  .num { text-align: right; }
  .sig { width: 46px; }
  tr { page-break-inside: avoid; }
  @media print { body { margin: 8mm; } }
</style></head>
<body>
  <h1>Dispatch List (Work-to List)</h1>
  <div class="meta">Generated ${now} · Schedule ${schedule?.scheduleId?.slice(0, 8) || ''} · ${totalOps} operations</div>
  ${sections || '<p>No operations match the current filters.</p>'}
  <script>window.onload = () => window.print();</script>
</body></html>`);
    win.document.close();
  };

  if (!schedule) {
    return <div className="dispatch-view empty">Generate or load a schedule to build dispatch lists.</div>;
  }

  return (
    <div className="dispatch-view">
      <div className="dispatch-toolbar">
        <div className="dispatch-title">
          <h3>Dispatch Lists</h3>
          <span className="dispatch-sub">{totalOps} operations · {byResource.size} resources</span>
        </div>
        <div className="dispatch-filters">
          <select value={resourceFilter} onChange={(e) => setResourceFilter(e.target.value)} aria-label="Resource">
            <option value="all">All resources</option>
            {resources.map((r) => (
              <option key={r.resourceId} value={r.resourceId}>
                {r.name || r.resourceId} ({r.worcentreId})
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dayFilter}
            onChange={(e) => setDayFilter(e.target.value)}
            aria-label="Day"
            title="Show only operations starting on this day"
          />
          {dayFilter && (
            <button className="btn btn-sm" onClick={() => setDayFilter('')}>All days</button>
          )}
          <button className="btn btn-sm btn-primary" onClick={handlePrint} disabled={totalOps === 0}>
            <Printer size={13} /> Print
          </button>
        </div>
      </div>

      <div className="dispatch-body">
        {Array.from(byResource.entries()).map(([resourceId, rows]) => {
          const res = resourceById.get(resourceId);
          return (
            <div className="dispatch-group" key={resourceId}>
              <div className="dispatch-group-header">
                <strong>{res?.name || resourceId}</strong>
                <span className="dispatch-group-wc">{res?.worcentreId}</span>
                <span className="dispatch-group-count">{rows.length} ops</span>
              </div>
              <table className="dispatch-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Job</th>
                    <th>Op</th>
                    <th>Item</th>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th>Start</th>
                    <th>End</th>
                    <th className="num">Setup</th>
                    <th className="num">Run</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.jobId}-${r.opId}`} className={r.pinned ? 'pinned' : ''}>
                      <td>{i + 1}</td>
                      <td className="mono">{r.jobId}</td>
                      <td>{r.opId}</td>
                      <td className="mono">{r.itemCode}</td>
                      <td className="desc">{r.jobDescription}</td>
                      <td className="num">{r.quantity || '—'}</td>
                      <td>{fmtDT(r.plannedStartDate)}</td>
                      <td>{fmtDT(r.plannedEndDate)}</td>
                      <td className="num">{r.setupTime || 0}m</td>
                      <td className="num">{r.runTime || 0}m</td>
                      <td>
                        {r.pinned && <span className="dispatch-flag pin">PIN</span>}
                        {r.isOvertimeSlot && <span className="dispatch-flag ot">OT</span>}
                        {r.opStatus === 'InProgress' && <span className="dispatch-flag wip">WIP</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {byResource.size === 0 && (
          <div className="dispatch-empty">No operations match the current filters.</div>
        )}
      </div>
    </div>
  );
};

export default DispatchListView;
