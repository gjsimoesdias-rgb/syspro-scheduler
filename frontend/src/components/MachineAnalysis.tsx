/**
 * Machine analysis (LYNQ "Workunit Analysis"): for each machine, how its
 * working time splits into setup, run and idle over a period, and the load
 * per day as a heat strip. Busiest machines first. Computed from the plan
 * on screen (utils/machineAnalysis.ts).
 */
import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import type { Resource, Schedule } from '../types';
import { analyseMachines } from '../utils/machineAnalysis';
import './MachineAnalysis.css';

const hrs = (min: number) => (min / 60).toFixed(min >= 600 ? 0 : 1);

const MachineAnalysis: React.FC<{ schedule: Schedule | null; resources: Resource[] }> = ({ schedule, resources }) => {
  const [days, setDays] = useState(14);
  const [fromMode, setFromMode] = useState<'today' | 'plan'>('today');
  const [line, setLine] = useState('');

  const planStart = useMemo(() => {
    let min = Infinity;
    for (const js of schedule?.jobSchedules || []) {
      const t = js.plannedStartDate ? new Date(js.plannedStartDate).getTime() : NaN;
      if (Number.isFinite(t) && t < min) min = t;
    }
    return Number.isFinite(min) ? new Date(min) : new Date();
  }, [schedule]);
  const from = fromMode === 'plan' ? planStart : new Date();

  const rows = useMemo(
    () => analyseMachines(schedule, resources, from, days),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedule, resources, days, fromMode, planStart],
  );
  const lines = useMemo(() => Array.from(new Set(rows.map((r) => r.lineId))).sort(), [rows]);
  const shown = line ? rows.filter((r) => r.lineId === line) : rows;
  const totals = shown.reduce((t, r) => ({ a: t.a + r.availMin, s: t.s + r.setupMin, r: t.r + r.runMin }), { a: 0, s: 0, r: 0 });
  const totalLoad = totals.a ? Math.round(((totals.s + totals.r) / totals.a) * 100) : 0;

  if (!schedule) return <div className="ma-empty">Generate or open a plan to see machine load.</div>;

  return (
    <div className="machine-analysis">
      <div className="ma-toolbar">
        <h3>Machine analysis</h3>
        <label>From
          <select value={fromMode} onChange={(e) => setFromMode(e.target.value as 'today' | 'plan')}>
            <option value="today">Today</option>
            <option value="plan">Plan start</option>
          </select>
        </label>
        <label>Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>1 week</option>
            <option value={14}>2 weeks</option>
            <option value={28}>4 weeks</option>
          </select>
        </label>
        <label>Line
          <select value={line} onChange={(e) => setLine(e.target.value)}>
            <option value="">All lines</option>
            {lines.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <span className="ma-summary">
          {shown.length} machines · load <b>{totalLoad}%</b> · setup {hrs(totals.s)} h · run {hrs(totals.r)} h · idle {hrs(Math.max(0, totals.a - totals.s - totals.r))} h
        </span>
      </div>

      <div className="ma-legend" aria-hidden="true">
        <span><i className="ma-sw ma-setup" /> Setup</span>
        <span><i className="ma-sw ma-run" /> Run (busy)</span>
        <span><i className="ma-sw ma-idle" /> Idle</span>
        <span className="ma-legend-heat">Load per day: <i className="ma-heat" data-l="0" />0 <i className="ma-heat" data-l="2" />50% <i className="ma-heat" data-l="4" />100%</span>
      </div>

      <div className="ma-table-wrap">
        <table className="ma-table">
          <thead>
            <tr>
              <th>Machine</th><th>Line</th><th className="ma-bar-col">Setup / run / idle</th>
              <th className="num">Load</th><th className="num">Setup h</th><th className="num">Run h</th><th className="num">Idle h</th><th className="num">Ops</th>
              {shown[0]?.days.map((d) => (
                <th key={d.day} className="ma-day" title={d.day}>{format(new Date(d.day + 'T00:00:00'), 'dd')}<br /><small>{format(new Date(d.day + 'T00:00:00'), 'EEEEE')}</small></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const pct = (m: number) => (r.availMin ? (m / r.availMin) * 100 : 0);
              return (
                <tr key={r.machineId}>
                  <td className="ma-name" title={r.name !== r.machineId ? r.name : undefined}>{r.machineId}</td>
                  <td>{r.lineId}</td>
                  <td className="ma-bar-col">
                    <div className="ma-bar" role="img" aria-label={`Setup ${Math.round(pct(r.setupMin))}%, run ${Math.round(pct(r.runMin))}%, idle ${Math.round(pct(r.idleMin))}%`}>
                      <span className="ma-setup" style={{ width: `${pct(r.setupMin)}%` }} />
                      <span className="ma-run" style={{ width: `${pct(r.runMin)}%` }} />
                    </div>
                  </td>
                  <td className={`num ma-load${r.loadPct >= 90 ? ' ma-hot' : ''}`}>{r.availMin ? `${r.loadPct}%` : '—'}</td>
                  <td className="num">{hrs(r.setupMin)}</td>
                  <td className="num">{hrs(r.runMin)}</td>
                  <td className="num">{hrs(r.idleMin)}</td>
                  <td className="num">{r.ops}</td>
                  {r.days.map((d) => {
                    const level = d.availMin === 0 ? 'off' : String(Math.min(4, Math.ceil(d.loadPct / 25)));
                    return (
                      <td key={d.day} className="ma-day">
                        <i className="ma-heat" data-l={level}
                          title={d.availMin === 0 ? `${d.day}: not working` : `${d.day}: ${d.loadPct}% — setup ${hrs(d.setupMin)} h, run ${hrs(d.runMin)} h, idle ${hrs(d.idleMin)} h`} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={8} className="ma-empty">No machines.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MachineAnalysis;
