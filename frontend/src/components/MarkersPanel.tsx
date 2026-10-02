/**
 * Manage → Markers: LYNQ-style coloured job tags. Define them here, then set
 * one on a job from the grid (right-click → Marker). Shown as a chip in the
 * Marker column and a flag on the job's Gantt bars; filter by them in the
 * jobs filter bar.
 */
import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Trash2 } from 'lucide-react';
import { useMarkerStore, MARKER_COLOURS } from '../stores/markerStore';
import { apiErrorMessage } from '../services/api';
import './ShiftManagementTab.css';
import { confirmDialog } from './DialogHost';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'marker';

const MarkersPanel: React.FC = () => {
  const { definitions, assignments, loaded, load, save } = useMarkerStore();
  const [newName, setNewName] = useState('');
  const [newColour, setNewColour] = useState(MARKER_COLOURS[0]);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const usage = useMemo(() => {
    const m = new Map<string, number>();
    Object.values(assignments).forEach((id) => m.set(id, (m.get(id) || 0) + 1));
    return m;
  }, [assignments]);

  const persist = async (defs: typeof definitions, msg?: string) => {
    try {
      await save({ definitions: defs, assignments });
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save markers'));
    }
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    let id = slug(name);
    while (definitions.some((d) => d.id === id)) id = `${id}-2`;
    void persist([...definitions, { id, name, color: newColour }], `Marker "${name}" added`);
    setNewName('');
    setNewColour(MARKER_COLOURS[(definitions.length + 1) % MARKER_COLOURS.length]);
  };

  const update = (id: string, patch: { name?: string; color?: string }) =>
    persist(definitions.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const remove = async (id: string) => {
    const n = usage.get(id) || 0;
    if (n && !(await confirmDialog({ title: 'Remove marker', message: `Remove this marker? It is set on ${n} job(s).`, confirmLabel: 'Remove', danger: true }))) return;
    void persist(definitions.filter((d) => d.id !== id), 'Marker removed');
  };

  return (
    <div className="shifts-table-section crews-panel">
      <div className="shift-rule-note">
        Markers are coloured tags for jobs (e.g. <i>Customer rush</i>, <i>Trial run</i>). Set one with right-click → <b>Marker</b> on a job;
        it shows in the <b>Marker</b> column and as a flag on the job&rsquo;s Gantt bars.
      </div>
      <table className="shifts-table">
        <thead><tr><th>Colour</th><th>Name</th><th>Jobs</th><th /></tr></thead>
        <tbody>
          {definitions.map((d) => (
            <tr key={d.id}>
              <td><input type="color" className="marker-colour-input" value={d.color.toLowerCase()} aria-label={`Colour of ${d.name}`}
                onChange={(e) => void update(d.id, { color: e.target.value })} /></td>
              <td><input className="crews-input" defaultValue={d.name} aria-label="Marker name"
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) void update(d.id, { name: v }); }} /></td>
              <td><span className="marker-chip" style={{ ['--mk' as any]: d.color }}>{usage.get(d.id) || 0}</span></td>
              <td><button className="btn btn-sm" onClick={() => remove(d.id)} title="Remove marker"><Trash2 size={13} className="ui-icon" aria-hidden="true" /> Remove</button></td>
            </tr>
          ))}
          <tr>
            <td><input type="color" className="marker-colour-input" value={newColour.toLowerCase()} aria-label="New marker colour" onChange={(e) => setNewColour(e.target.value)} /></td>
            <td><input className="crews-input" placeholder="e.g. Customer rush" value={newName} maxLength={40}
              onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} /></td>
            <td />
            <td><button className="btn btn-sm" onClick={add} disabled={!newName.trim()}>+ Add marker</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default MarkersPanel;
