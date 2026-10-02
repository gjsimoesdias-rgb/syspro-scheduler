import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { versionService, scheduleService, apiErrorMessage, VersionSummary } from '../services/api';
import { useScheduleStore } from '../stores/scheduleStore';
import { useAuth } from '../context/AuthContext';
import { convertScheduleDates } from '../utils/scheduleDates';
import './VersionsPanel.css';
import AutoPlanCard from './AutoPlanCard';

/**
 * Plan versions — LYNQ-style Master + what-if model, backed by /api/versions.
 * Replaces the Scenarios tab, the Compare tab and the in-browser History list.
 *
 *  - Master: the plan the Gantt, dispatch and SYSPRO export use.
 *  - What-if: a copy you can regenerate or edit freely; commit it to make it the master.
 *  - History: earlier masters; revert to one, or copy it into a what-if.
 */

type Kpi = { key: string; label: string; better: 'high' | 'low'; fmt: (v: number) => string };
const KPIS: Kpi[] = [
  { key: 'totalJobsScheduled', label: 'Jobs scheduled', better: 'high', fmt: (v) => String(Math.round(v)) },
  { key: 'jobsUnscheduled', label: 'Unscheduled', better: 'low', fmt: (v) => String(Math.round(v)) },
  { key: 'otdRate', label: 'On-time %', better: 'high', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'jobsTardy', label: 'Late jobs', better: 'low', fmt: (v) => String(Math.round(v)) },
  { key: 'averageTardiness', label: 'Avg late (days)', better: 'low', fmt: (v) => v.toFixed(2) },
  { key: 'avgLeadTimeDays', label: 'Lead time (days)', better: 'low', fmt: (v) => v.toFixed(1) },
  { key: 'resourceUtilization', label: 'Utilization', better: 'high', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'directDowntimePct', label: 'Setup time %', better: 'low', fmt: (v) => `${v.toFixed(1)}%` },
  { key: 'totalOvertimeHours', label: 'Overtime (h)', better: 'low', fmt: (v) => v.toFixed(1) },
  { key: 'violations', label: 'Violations', better: 'low', fmt: (v) => String(Math.round(v)) },
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const when = (d: string) => new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const VersionsPanel: React.FC = () => {
  const { isRole } = useAuth();
  const canPlan = isRole('super_admin', 'company_admin', 'planner', 'Approver');
  const canPurge = isRole('super_admin', 'company_admin');
  const activeVersion = useScheduleStore((s) => s.activeVersion);
  const setActiveVersion = useScheduleStore((s) => s.setActiveVersion);
  const setSchedule = useScheduleStore((s) => s.setSchedule);
  const boardScheduleId = useScheduleStore((s) => s.schedule?.scheduleId ?? null);
  const setScheduleSource = useScheduleStore((s) => s.setScheduleSource);

  const [data, setData] = useState<{ master: VersionSummary | null; whatIfs: VersionSummary[]; history: VersionSummary[] }>({
    master: null, whatIfs: [], history: [],
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [purgeDays, setPurgeDays] = useState(90);
  const [publish, setPublish] = useState<Awaited<ReturnType<typeof versionService.publishStatus>> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await versionService.list(50));
      setLoadError(null);
      versionService.publishStatus().then(setPublish).catch(() => setPublish(null));
    } catch (err) {
      const status = (err as any)?.response?.status;
      setLoadError(status === 404
        ? 'The server running on port 3000 is an older build without plan versions. Stop it and run START_SCHEDULER.cmd again.'
        : apiErrorMessage(err, 'Could not load versions'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const all = useMemo(
    () => [...(data.master ? [data.master] : []), ...data.whatIfs, ...data.history],
    [data]
  );
  const byId = useMemo(() => new Map(all.map((v) => [v.versionId, v])), [all]);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (err) { toast.error(apiErrorMessage(err, 'Version action failed')); } finally { setBusy(null); }
  };

  const openMaster = async () => {
    const { schedule } = await scheduleService.openLatest();
    setActiveVersion(null);
    if (schedule) {
      setSchedule(convertScheduleDates(schedule));
      setScheduleSource('restored');
    }
  };

  const openVersion = (v: VersionSummary) => run(v.versionId, async () => {
    if (v.kind === 'Master') {
      await openMaster();
      toast.success('Master plan opened');
      return;
    }
    const { schedule } = await versionService.get(v.versionId);
    setSchedule(convertScheduleDates(schedule));
    setScheduleSource('restored');
    setActiveVersion({ versionId: v.versionId, name: v.name });
    toast.success(`What-if "${v.name}" opened — Generate and board edits now go into it`);
  });

  const newWhatIf = (from?: VersionSummary) => {
    const suggested = from ? `${from.name} (copy)` : `What-if ${new Date().toLocaleDateString()}`;
    const name = window.prompt(from ? `New what-if copied from "${from.name}". Name:` : 'New what-if copied from the master plan. Name:', suggested);
    if (!name?.trim()) return;
    run(from?.versionId || 'new', async () => {
      const v = await versionService.createWhatIf(name.trim(), from?.versionId);
      await load();
      toast.success(`What-if "${v.name}" created`);
    });
  };

  const commit = (v: VersionSummary) => {
    if (!window.confirm(`Make "${v.name}" the master plan?\n\nThe current master is kept in History. The new master is a Draft and must be approved again before it can be sent to SYSPRO.`)) return;
    run(v.versionId, async () => {
      await versionService.commit(v.versionId);
      await openMaster();
      await load();
      toast.success(`"${v.name}" is now the master plan`);
    });
  };

  const revert = (v: VersionSummary) => {
    if (!window.confirm(`Revert the master plan to "${v.name}" (${when(v.savedAt)})?\n\nThe current master is kept in History. The reverted plan must be approved again before it can be sent to SYSPRO.`)) return;
    run(v.versionId, async () => {
      await versionService.revert(v.versionId);
      await openMaster();
      await load();
      toast.success('Master plan reverted');
    });
  };

  const rename = (v: VersionSummary) => {
    const name = window.prompt('Rename version', v.name);
    if (!name?.trim() || name.trim() === v.name) return;
    run(v.versionId, async () => {
      await versionService.rename(v.versionId, name.trim());
      if (activeVersion?.versionId === v.versionId) setActiveVersion({ versionId: v.versionId, name: name.trim() });
      await load();
    });
  };

  const remove = (v: VersionSummary) => {
    if (!window.confirm(`Delete "${v.name}"? This cannot be undone.`)) return;
    run(v.versionId, async () => {
      await versionService.remove(v.versionId);
      if (activeVersion?.versionId === v.versionId) await openMaster();
      setSelected((s) => s.filter((id) => id !== v.versionId));
      await load();
    });
  };

  const purge = () => {
    if (!window.confirm(`Delete history versions older than ${purgeDays} days?\n\nThe master, all what-ifs, the newest 20 history versions and the last plan sent to SYSPRO are always kept.`)) return;
    run('purge', async () => {
      const n = await versionService.purge(purgeDays, 20);
      await load();
      toast.success(`${n} old version${n === 1 ? '' : 's'} deleted`);
    });
  };

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 4 ? [...s.slice(1), id] : [...s, id]));

  const compared = selected.map((id) => byId.get(id)).filter(Boolean) as VersionSummary[];

  const best = (k: Kpi): number | null => {
    const vals = compared.map((v) => num(v.metrics?.[k.key])).filter((x): x is number => x !== null);
    if (vals.length < 2) return null;
    return k.better === 'high' ? Math.max(...vals) : Math.min(...vals);
  };

  const row = (v: VersionSummary) => {
    const m = v.metrics || {};
    // "On board" only when the board really shows this plan (after a reload the
    // board is rebuilt from SYSPRO dates, not the saved master).
    const isOpen = v.kind === 'WhatIf'
      ? activeVersion?.versionId === v.versionId
      : v.kind === 'Master' && !activeVersion && boardScheduleId === v.versionId;
    return (
      <tr key={v.versionId} className={isOpen ? 'vp-row-open' : undefined}>
        <td><input type="checkbox" aria-label={`Compare ${v.name}`} checked={selected.includes(v.versionId)} onChange={() => toggle(v.versionId)} /></td>
        <td>
          <span className={`vp-kind vp-kind-${v.kind.toLowerCase()}`}>{v.kind === 'WhatIf' ? 'What-if' : v.kind}</span>
          <strong className="vp-name">{v.name}</strong>
          {isOpen && <span className="vp-open-tag">on board</span>}
        </td>
        <td>{v.status}</td>
        <td>{when(v.savedAt)}{v.createdBy ? <span className="vp-by"> · {v.createdBy}</span> : null}</td>
        <td className="vp-num">{num(m.otdRate) !== null ? `${m.otdRate.toFixed(1)}%` : '—'}</td>
        <td className="vp-num">{num(m.jobsTardy) ?? '—'}</td>
        <td className="vp-num">{num(m.resourceUtilization) !== null ? `${m.resourceUtilization.toFixed(1)}%` : '—'}</td>
        <td className="vp-num">{num(m.violations) ?? '—'}</td>
        <td className="vp-actions">
          {v.kind !== 'History' && !isOpen && <button className="btn btn-sm" disabled={!!busy} onClick={() => openVersion(v)}>Open</button>}
          {canPlan && v.kind === 'WhatIf' && <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => commit(v)}>Commit to master</button>}
          {canPlan && v.kind === 'History' && <button className="btn btn-sm" disabled={!!busy} onClick={() => revert(v)}>Revert to this</button>}
          {canPlan && <button className="btn btn-sm" disabled={!!busy} onClick={() => newWhatIf(v)} title="Copy into a new what-if">Copy</button>}
          {canPlan && v.kind !== 'History' && <button className="btn btn-sm" disabled={!!busy} onClick={() => rename(v)}>Rename</button>}
          {canPlan && v.kind !== 'Master' && <button className="btn btn-sm" disabled={!!busy} onClick={() => remove(v)}>Delete</button>}
        </td>
      </tr>
    );
  };

  return (
    <div className="versions-panel">
      <div className="vp-header">
        <div>
          <h3>Plan versions</h3>
          <p className="vp-desc">
            The <strong>master</strong> is what the board, dispatch and SYSPRO export use. A <strong>what-if</strong> is a copy
            you can regenerate or edit without touching the master — commit it when it&apos;s better. Tick up to four rows to compare.
          </p>
        </div>
        <div className="vp-header-actions">
          {canPlan && <button className="btn btn-primary" disabled={!!busy || !data.master} onClick={() => newWhatIf()}>+ New what-if</button>}
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {activeVersion && (
        <div className="vp-banner" role="status">
          Working in what-if <strong>{activeVersion.name}</strong>. Generate and board edits go into it; the master is unchanged.
          <span className="vp-banner-actions">
            <button className="btn btn-sm" onClick={() => run('master', openMaster)}>Back to master</button>
            {canPlan && byId.get(activeVersion.versionId) && (
              <button className="btn btn-sm btn-primary" onClick={() => commit(byId.get(activeVersion.versionId)!)}>Commit to master</button>
            )}
          </span>
        </div>
      )}

      {publish && (publish.jobs.length > 0) && (
        <div className="vp-publish">
          <strong>SYSPRO sync (master plan):</strong>
          <span className="vp-pub vp-pub-published">{publish.counts.Published} published</span>
          <span className="vp-pub vp-pub-pending">{publish.counts.Pending} pending</span>
          {publish.counts.Error > 0 && <span className="vp-pub vp-pub-error">{publish.counts.Error} error</span>}
          <span className="vp-desc">Send to SYSPRO writes only pending and error jobs.</span>
          {canPlan && publish.counts.Published > 0 && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => {
              if (!window.confirm('Mark every job for re-sending? The next Send to SYSPRO will write all scheduled jobs again.')) return;
              run('resend', async () => {
                await versionService.resetPublish(publish.jobs.map((j) => j.jobId));
                await load();
              });
            }}>Re-send all next time</button>
          )}
          {publish.jobs.filter((j) => j.state === 'Error').slice(0, 5).map((j) => (
            <div key={j.jobId} className="vp-pub-errline">Job {j.jobId}: {j.lastError}</div>
          ))}
        </div>
      )}

      <AutoPlanCard canPlan={canPlan} onPlanned={load} />

      {compared.length >= 2 && (
        <div className="vp-compare">
          <h4>Compare</h4>
          <table className="vp-table">
            <thead>
              <tr><th>KPI</th>{compared.map((v) => <th key={v.versionId} className="vp-num">{v.name}</th>)}</tr>
            </thead>
            <tbody>
              {KPIS.map((k) => {
                const b = best(k);
                return (
                  <tr key={k.key}>
                    <td>{k.label}</td>
                    {compared.map((v) => {
                      const val = num(v.metrics?.[k.key]);
                      return (
                        <td key={v.versionId} className={`vp-num${val !== null && b !== null && val === b ? ' vp-best' : ''}`}>
                          {val === null ? '—' : k.fmt(val)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <table className="vp-table">
        <thead>
          <tr>
            <th aria-label="Compare" />
            <th>Version</th>
            <th>Status</th>
            <th>Saved</th>
            <th className="vp-num">On-time</th>
            <th className="vp-num">Late</th>
            <th className="vp-num">Utilization</th>
            <th className="vp-num">Violations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.master && row(data.master)}
          {data.whatIfs.map(row)}
          {data.history.length > 0 && (
            <tr className="vp-section"><td colSpan={9}>History — earlier master plans</td></tr>
          )}
          {data.history.map(row)}
          {loadError && (
            <tr><td colSpan={9} className="vp-empty vp-error">{loadError}</td></tr>
          )}
          {!loading && !loadError && all.length === 0 && (
            <tr><td colSpan={9} className="vp-empty">No saved plans yet — generate a schedule first.</td></tr>
          )}
        </tbody>
      </table>

      {canPurge && data.history.length > 0 && (
        <div className="vp-retention">
          <label htmlFor="vp-purge-days">Retention: delete history older than</label>
          <input id="vp-purge-days" type="number" min={1} max={3650} value={purgeDays}
            onChange={(e) => setPurgeDays(Math.max(1, Number(e.target.value) || 1))} />
          <span>days</span>
          <button className="btn btn-sm" disabled={!!busy} onClick={purge}>Purge</button>
        </div>
      )}
    </div>
  );
};

export default VersionsPanel;
