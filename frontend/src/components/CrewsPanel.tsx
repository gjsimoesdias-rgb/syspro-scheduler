/**
 * Manage → Crews: operator crews shared by an area's lines.
 *
 * Employees come from SYSPRO (BomEmployee) and are mapped to crews here; a
 * crew's operators = its mapped employees. A crew with nobody mapped uses a
 * manual headcount (for companies that don't maintain BomEmployee). Each line
 * is assigned to a crew with the operators it needs. When enabled, the
 * scheduler never runs more operations at once in a crew than it can staff.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  crewService, resourceService, apiErrorMessage,
  type CrewSetup, type CrewPool, type SysproEmployee,
} from '../services/api';
import './ShiftManagementTab.css';
import type { WorkcentreRow } from '../services/api';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'crew';
const operatorsOf = (p: CrewPool) => (p.employees?.length ? p.employees.length : p.headcount);

const CrewsPanel: React.FC<{ workcentreIds: string[] }> = ({ workcentreIds }) => {
  const [setup, setSetup] = useState<CrewSetup>({ enabled: false, pools: [], lines: {} });
  const [saved, setSaved] = useState('');
  const [wcNames, setWcNames] = useState<Record<string, string>>({});
  const [employees, setEmployees] = useState<SysproEmployee[]>([]);
  const [employeeNote, setEmployeeNote] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [shiftTemplates, setShiftTemplates] = useState<Array<{ shiftId: string; name: string; startTime?: string; endTime?: string }>>([]);

  const load = useCallback(async () => {
    try {
      const s = await crewService.get();
      const clean = { ...s, pools: s.pools.map((p) => ({ ...p, employees: p.employees ?? [] })) };
      setSetup(clean);
      setSaved(JSON.stringify(clean));
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load crews'));
    }
  }, []);

  useEffect(() => {
    load();
    crewService.employees()
      .then((r) => { setEmployees(r.employees); setEmployeeNote(r.note); })
      .catch((err) => setEmployeeNote(apiErrorMessage(err, 'Could not read SYSPRO employees')));
    resourceService.getDefinitions()
      .then((r) => setShiftTemplates((r.shifts || []).map((t) => ({ shiftId: String(t.shiftId), name: String(t.name), startTime: t.startTime, endTime: t.endTime }))))
      .catch(() => setShiftTemplates([]));
    resourceService.getWorkcentres()
      .then((rows: WorkcentreRow[]) => setWcNames(Object.fromEntries((rows || []).map((w) => [
        String(w.worcentreId ?? w.workcentreId ?? w.id), String(w.name ?? w.description ?? ''),
      ]))))
      .catch(() => setWcNames({}));
  }, [load]);

  const dirty = JSON.stringify(setup) !== saved;
  const lines = useMemo(
    () => Array.from(new Set([...workcentreIds, ...Object.keys(setup.lines)])).sort(),
    [workcentreIds, setup.lines],
  );
  const crewOfEmployee = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of setup.pools) for (const e of p.employees ?? []) m.set(e, p.id);
    return m;
  }, [setup.pools]);
  const knownCodes = useMemo(() => new Set(employees.map((e) => e.code)), [employees]);
  /** CRUX shift an employee's SYSPRO ShiftId matches (by id or name, case-insensitive). */
  const shiftFor = useCallback((code?: string) => {
    const c = (code || '').trim().toLowerCase();
    return c ? shiftTemplates.find((t) => t.shiftId.toLowerCase() === c || t.name.trim().toLowerCase() === c) : undefined;
  }, [shiftTemplates]);
  const employeeByCode = useMemo(() => new Map(employees.map((e) => [e.code, e] as const)), [employees]);
  /** Distinct CRUX shifts among a crew's employees (empty = everyone counts all the time). */
  const crewShifts = (p: CrewPool) => Array.from(new Set((p.employees ?? [])
    .map((c) => shiftFor(employeeByCode.get(c)?.shiftId)?.name).filter(Boolean) as string[]));
  const linesOf = (poolId: string) => Object.entries(setup.lines).filter(([, l]) => l.poolId === poolId).map(([wc]) => wc);

  // ── Crews ──
  const addPool = () => {
    const name = newName.trim();
    if (!name) { toast.error('Give the crew a name'); return; }
    let id = slug(name);
    while (setup.pools.some((p) => p.id === id)) id = `${id}-2`;
    setSetup({ ...setup, pools: [...setup.pools, { id, name, headcount: 0, employees: [] }] });
    setNewName('');
  };
  const updatePool = (id: string, patch: Partial<CrewPool>) =>
    setSetup({ ...setup, pools: setup.pools.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const removePool = (id: string) => setSetup({
    ...setup,
    pools: setup.pools.filter((p) => p.id !== id),
    lines: Object.fromEntries(Object.entries(setup.lines).filter(([, l]) => l.poolId !== id)),
  });

  // ── Employees ──
  const assignEmployee = (code: string, poolId: string) => setSetup({
    ...setup,
    pools: setup.pools.map((p) => {
      const rest = (p.employees ?? []).filter((e) => e !== code);
      return { ...p, employees: p.id === poolId ? [...rest, code] : rest };
    }),
  });
  /** Put each unmapped employee in the crew of their SYSPRO work centre's line. */
  const autoAssign = () => {
    let n = 0;
    const pools = setup.pools.map((p) => ({ ...p, employees: [...(p.employees ?? [])] }));
    for (const e of employees) {
      if (crewOfEmployee.has(e.code) || !e.workCentre) continue;
      const poolId = setup.lines[e.workCentre]?.poolId;
      const pool = poolId && pools.find((p) => p.id === poolId);
      if (pool) { pool.employees.push(e.code); n++; }
    }
    setSetup({ ...setup, pools });
    toast(n ? `${n} employee${n === 1 ? '' : 's'} assigned by SYSPRO work centre` : 'Nobody to assign — map lines to crews first, or employees are already assigned', { icon: 'ℹ️' });
  };

  // ── Lines ──
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

  const q = filter.trim().toLowerCase();
  const shownEmployees = employees.filter((e) => !q || `${e.code} ${e.name} ${e.workCentre ?? ''}`.toLowerCase().includes(q));
  const orphanCodes = setup.pools.flatMap((p) => (p.employees ?? []).filter((c) => employees.length && !knownCodes.has(c)));

  return (
    <div className="shifts-table-section crews-panel">
      <div className="shift-rule-note">
        Operators are shared by the lines in a crew. A crew&rsquo;s operators are the SYSPRO employees
        (BomEmployee) mapped to it below; an employee whose SYSPRO ShiftId matches a CRUX shift
        (Manage → Shifts, by code or name) only counts while that shift is working. When crew limits are on, the scheduler only runs an operation
        while its crew has enough free operators — a crew of 6 runs two lines that need 3 each, and a third
        line waits. Applies to the next <strong>Generate</strong> (forward scheduling).
      </div>

      <label className="crews-enable">
        <input type="checkbox" checked={setup.enabled} onChange={(e) => setSetup({ ...setup, enabled: e.target.checked })} />
        Apply crew limits when scheduling
      </label>

      <h4 className="crews-heading">Crews</h4>
      <table className="shifts-table">
        <thead><tr><th>Crew</th><th>Employees</th><th>Operators</th><th>Lines</th><th /></tr></thead>
        <tbody>
          {setup.pools.map((p) => {
            const mapped = p.employees?.length ?? 0;
            return (
              <tr key={p.id}>
                <td><input className="crews-input" value={p.name} onChange={(e) => updatePool(p.id, { name: e.target.value })} /></td>
                <td>{mapped}</td>
                <td>
                  {mapped > 0 ? (
                    <>
                      <strong title="Employees mapped to this crew">{mapped}</strong>
                      {crewShifts(p).length > 0 && (
                        <span className="crews-hint" title="Employees only count while their shift is working">
                          varies by shift ({crewShifts(p).join(', ')})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="crews-manual" title="No employees mapped — this manual headcount is used instead">
                      <input className="crews-input crews-num" type="number" min={0} step={1} value={p.headcount}
                        onChange={(e) => updatePool(p.id, { headcount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                      <span className="crews-hint">manual</span>
                    </span>
                  )}
                </td>
                <td>{linesOf(p.id).join(', ') || '—'}</td>
                <td><button className="btn btn-sm" onClick={() => removePool(p.id)}>Remove</button></td>
              </tr>
            );
          })}
          <tr>
            <td><input className="crews-input" placeholder="e.g. Packing crew" value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPool(); }} /></td>
            <td colSpan={3} />
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
                <td>{wcNames[wc] || ''}</td>
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

      <h4 className="crews-heading">Employees <span className="crews-hint">from SYSPRO BomEmployee</span></h4>
      {employees.length === 0 ? (
        <div className="no-shifts crews-empty">
          {employeeNote || 'No employees in SYSPRO (BomEmployee).'} Crews use their manual headcount until employees are mapped.
        </div>
      ) : (
        <>
          <div className="crews-toolbar">
            <input className="crews-input" placeholder="Filter by code, name or work centre" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="btn btn-sm" onClick={autoAssign} disabled={!setup.pools.length}
              title="Put each unassigned employee in the crew of their SYSPRO work centre's line">
              Auto-assign by work centre
            </button>
            <span className="crews-hint">{crewOfEmployee.size} of {employees.length} assigned</span>
          </div>
          <table className="shifts-table">
            <thead><tr><th>Employee</th><th>Name</th><th>SYSPRO work centre</th><th>Shift</th><th>Crew</th></tr></thead>
            <tbody>
              {shownEmployees.map((e) => { const sh = e.shiftId ? shiftFor(e.shiftId) : undefined; return (
                <tr key={e.code} className={e.active ? '' : 'crews-inactive'}>
                  <td>{e.code}</td>
                  <td>{e.name}{!e.active && <span className="crews-hint"> (inactive)</span>}</td>
                  <td>{e.workCentre || '—'}</td>
                  <td>
                    {e.shiftId ? (
                      sh
                        ? <span title="Counts toward the crew only while this CRUX shift is working">{e.shiftId} → {sh.name}{sh.startTime ? ` (${sh.startTime}–${sh.endTime})` : ''}</span>
                        : <span className="crews-hint" title="No CRUX shift with this code or name (Manage → Shifts) — counts all the time">{e.shiftId} (no CRUX shift)</span>
                    ) : '—'}
                  </td>
                  <td>
                    <select className="crews-input" value={crewOfEmployee.get(e.code) || ''} onChange={(ev) => assignEmployee(e.code, ev.target.value)}>
                      <option value="">— none —</option>
                      {setup.pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </>
      )}
      {orphanCodes.length > 0 && (
        <div className="shift-rule-note">
          {orphanCodes.length} mapped employee{orphanCodes.length === 1 ? ' is' : 's are'} no longer in SYSPRO ({orphanCodes.slice(0, 6).join(', ')}) — they still count until removed.
        </div>
      )}

      <div className="crews-actions">
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save crews' : 'Saved'}
        </button>
        {dirty && <button className="btn btn-sm" onClick={load} disabled={saving}>Discard changes</button>}
        <span className="crews-hint">
          {setup.pools.map((p) => `${p.name}: ${operatorsOf(p)} operators`).join(' · ')}
        </span>
      </div>
    </div>
  );
};

export default CrewsPanel;
