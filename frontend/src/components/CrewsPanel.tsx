/**
 * Manage → Crews: operator pools shared by an area's lines, and how many
 * operators each line needs. When enabled, the scheduler never runs more
 * operations at once in a pool than its headcount can staff.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { crewService, resourceService, apiErrorMessage, type CrewSetup, type CrewPool } from '../services/api';
import './ShiftManagementTab.css';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'crew';

const CrewsPanel: React.FC<{ workcentreIds: string[] }> = ({ workcentreIds }) => {
  const [setup, setSetup] = useState<CrewSetup>({ enabled: false, pools: [], lines: {} });
  const [saved, setSaved] = useState<string>('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHeadcount, setNewHeadcount] = useState('4');

  const load = useCallback(async () => {
    try {
      const s = await crewService.get();
      setSetup(s);
      setSaved(JSON.stringify(s));
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load crews'));
    }
  }, []);

  useEffect(() => {
    load();
    resourceService.getWorkcentres()
      .then((rows: any[]) => setNames(Object.fromEntries((rows || []).map((w) => [
        String(w.worcentreId ?? w.workcentreId ?? w.id), String(w.name ?? w.description ?? ''),
      ]))))
      .catch(() => setNames({}));
  }, [load]);

  const dirty = JSON.stringify(setup) !== saved;
  const lines = useMemo(
    () => Array.from(new Set([...workcentreIds, ...Object.keys(setup.lines)])).sort(),
    [workcentreIds, setup.lines],
  );
  const usedBy = (poolId: string) => Object.values(setup.lines).filter((l) => l.poolId === poolId).length;

  const addPool = () => {
    const name = newName.trim();
    const headcount = Number(newHeadcount);
    if (!name) { toast.error('Give the crew a name'); return; }
    if (!Number.isInteger(headcount) || headcount < 0) { toast.error('Headcount must be a whole number'); return; }
    let id = slug(name);
    while (setup.pools.some((p) => p.id === id)) id = `${id}-2`;
    setSetup({ ...setup, pools: [...setup.pools, { id, name, headcount }] });
    setNewName('');
  };

  const updatePool = (id: string, patch: Partial<CrewPool>) =>
    setSetup({ ...setup, pools: setup.pools.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const removePool = (id: string) => {
    const lines = Object.fromEntries(Object.entries(setup.lines).filter(([, l]) => l.poolId !== id));
    setSetup({ ...setup, pools: setup.pools.filter((p) => p.id !== id), lines });
  };

  const setLine = (wc: string, poolId: string, operators?: number) => {
    const next = { ...setup.lines };
    if (!poolId) delete next[wc];
    else next[wc] = { poolId, operators: operators ?? next[wc]?.operators ?? 1 };
    setSetup({ ...setup, lines: next });
  };

  const save = async () => {
    setSaving(true);
    try {
      const s = await crewService.save(setup);
      setSetup(s);
      setSaved(JSON.stringify(s));
      toast.success('Crews saved — regenerate the schedule to apply them');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save crews'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="shifts-table-section crews-panel">
      <div className="shift-rule-note">
        Operators are shared by the lines in a crew. When crew limits are on, the scheduler only runs
        an operation while its crew has enough free operators — e.g. a crew of 6 can run two lines that
        each need 3, and a third line waits. Applies to the next <strong>Generate</strong> (forward scheduling).
      </div>

      <label className="crews-enable">
        <input type="checkbox" checked={setup.enabled} onChange={(e) => setSetup({ ...setup, enabled: e.target.checked })} />
        Apply crew limits when scheduling
      </label>

      <h4 className="crews-heading">Crews</h4>
      <table className="shifts-table">
        <thead><tr><th>Crew</th><th>Operators per shift</th><th>Lines</th><th /></tr></thead>
        <tbody>
          {setup.pools.map((p) => (
            <tr key={p.id}>
              <td><input className="crews-input" value={p.name} onChange={(e) => updatePool(p.id, { name: e.target.value })} /></td>
              <td>
                <input className="crews-input crews-num" type="number" min={0} step={1} value={p.headcount}
                  onChange={(e) => updatePool(p.id, { headcount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
              </td>
              <td>{usedBy(p.id)}</td>
              <td><button className="btn btn-sm" onClick={() => removePool(p.id)}>Remove</button></td>
            </tr>
          ))}
          <tr>
            <td><input className="crews-input" placeholder="e.g. Packing crew" value={newName} onChange={(e) => setNewName(e.target.value)} /></td>
            <td><input className="crews-input crews-num" type="number" min={0} step={1} value={newHeadcount} onChange={(e) => setNewHeadcount(e.target.value)} /></td>
            <td />
            <td><button className="btn btn-sm" onClick={addPool}>+ Add crew</button></td>
          </tr>
        </tbody>
      </table>

      <h4 className="crews-heading">Lines</h4>
      <table className="shifts-table">
        <thead><tr><th>Line</th><th>Description</th><th>Crew</th><th>Operators needed</th></tr></thead>
        <tbody>
          {lines.map((wc) => {
            const line = setup.lines[wc];
            return (
              <tr key={wc}>
                <td>{wc}</td>
                <td>{names[wc] || ''}</td>
                <td>
                  <select className="crews-input" value={line?.poolId || ''} onChange={(e) => setLine(wc, e.target.value)}>
                    <option value="">— not crew-limited —</option>
                    {setup.pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
                <td>
                  {line ? (
                    <input className="crews-input crews-num" type="number" min={0.5} step={0.5} value={line.operators}
                      onChange={(e) => setLine(wc, line.poolId, Math.max(0.5, Number(e.target.value) || 1))} />
                  ) : '—'}
                </td>
              </tr>
            );
          })}
          {lines.length === 0 && <tr><td colSpan={4} className="no-shifts">No lines loaded yet.</td></tr>}
        </tbody>
      </table>

      <div className="crews-actions">
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save crews' : 'Saved'}
        </button>
        {dirty && <button className="btn btn-sm" onClick={load} disabled={saving}>Discard changes</button>}
      </div>
    </div>
  );
};

export default CrewsPanel;
