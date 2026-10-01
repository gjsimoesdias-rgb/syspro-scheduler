/**
 * Versions → Auto plan: background re-planning into the "Auto plan" what-if
 * (backend: services/autoScheduler.ts). The master is never touched.
 */
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { autoPlanService, AutoPlanConfig, AutoPlanStatus, apiErrorMessage } from '../services/api';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

export default function AutoPlanCard({ canPlan, onPlanned }: { canPlan: boolean; onPlanned: () => void }) {
  const [config, setConfig] = useState<AutoPlanConfig | null>(null);
  const [status, setStatus] = useState<AutoPlanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await autoPlanService.get();
      setConfig(r.config); setStatus(r.status); setUnavailable(false);
    } catch { setUnavailable(true); }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  // A run that finished since the last poll → reload the versions list.
  const [seenRun, setSeenRun] = useState<string | undefined>();
  useEffect(() => {
    if (status?.lastRunAt && seenRun && status.lastRunAt !== seenRun) onPlanned();
    if (status?.lastRunAt) setSeenRun(status.lastRunAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.lastRunAt]);

  const save = async (patch: Partial<AutoPlanConfig>) => {
    setBusy(true);
    try {
      const r = await autoPlanService.save(patch);
      setConfig(r.config); setStatus(r.status);
      if (patch.enabled !== undefined) toast.success(patch.enabled ? 'Auto plan on — the first run starts within a minute' : 'Auto plan off');
    } catch (e) { toast.error(apiErrorMessage(e, 'Could not save Auto plan settings')); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await autoPlanService.runNow();
      setStatus(r.status);
      toast.success('Auto plan updated');
      onPlanned();
    } catch (e) { toast.error(apiErrorMessage(e, 'Auto plan run failed')); void refresh(); }
    finally { setBusy(false); }
  };

  if (unavailable || !config) return null;
  const r = status?.lastResult;
  return (
    <div className="vp-auto">
      <div className="vp-auto-head">
        <strong>Auto plan</strong>
        <span className="vp-desc">
          Re-plans in the background into the <em>Auto plan</em> what-if with your last Generate options, from now.
          The master is never changed — compare it below and commit when it&apos;s better.
        </span>
      </div>
      <div className="vp-auto-row">
        <label><input type="checkbox" checked={config.enabled} disabled={!canPlan || busy} onChange={(e) => save({ enabled: e.target.checked })} /> On</label>
        <label>Every
          <select value={config.intervalMinutes} disabled={!canPlan || busy} onChange={(e) => save({ intervalMinutes: Number(e.target.value) })}>
            {[0, 15, 30, 60, 120, 240, 480, 1440].map((m) => (
              <option key={m} value={m}>{m === 0 ? 'only on change' : m < 60 ? `${m} min` : `${m / 60} h`}</option>
            ))}
          </select>
        </label>
        <label><input type="checkbox" checked={config.onJobChange} disabled={!canPlan || busy} onChange={(e) => save({ onJobChange: e.target.checked })} /> and when SYSPRO jobs change (checked every {config.checkMinutes} min)</label>
        {canPlan && <button className="btn btn-sm" disabled={busy || status?.running} onClick={runNow}>{busy || status?.running ? 'Planning…' : 'Run now'}</button>}
      </div>
      <div className="vp-auto-status">
        {status?.running && <span>Planning now…</span>}
        {!status?.running && status?.lastRunAt && (
          <span>
            Last run {when(status.lastRunAt)} ({status.lastReason}){' '}
            {r?.ok
              ? <>— {r.scheduled ?? 0} scheduled{r.unscheduled ? `, ${r.unscheduled} unscheduled` : ''}{r.late ? `, ${r.late} late` : ''} in {Math.round((r.ms ?? 0) / 1000)} s</>
              : <span className="vp-pub-error">— failed: {r?.error}</span>}
          </span>
        )}
        {!status?.lastRunAt && <span className="vp-desc">Not run yet since the server started.</span>}
        {config.enabled && status?.nextRunAt && <span className="vp-desc"> · next by {when(status.nextRunAt)}</span>}
        {config.enabled && config.enabledBy && <span className="vp-desc"> · on by {config.enabledBy}</span>}
      </div>
    </div>
  );
}
