/**
 * SetupMatrixEditor — manage sequence-dependent changeover times.
 *
 * The scheduling engine (greedy + CP-SAT) charges the matrix value instead of
 * the operation's default setup time whenever an item transition on the same
 * resource matches a row here. Workcentre-specific rows win over generic ones.
 */
import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { apiClient, apiErrorMessage } from '../services/api';
import type { Resource } from '../types';
import './SetupMatrixEditor.css';

interface MatrixRow {
  setupId: string;
  workcentreId: string;
  fromItemCode: string;
  toItemCode: string;
  setupMinutes: number;
  updatedAt?: string;
}

interface Props {
  resources: Resource[];
}

const SetupMatrixEditor: React.FC<Props> = ({ resources }) => {
  const [rows, setRows] = useState<MatrixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  // New-row form state
  const [newWc, setNewWc] = useState('');
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [newMinutes, setNewMinutes] = useState<string>('30');
  const [saving, setSaving] = useState(false);

  const workcentres = useMemo(
    () => Array.from(new Set(resources.map((r) => r.worcentreId))).sort(),
    [resources]
  );

  const load = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get('/schedule/setup-matrix');
      setRows(res.data?.rows || []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to load changeover matrix'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addRow = async () => {
    const minutes = Number(newMinutes);
    if (!newWc || !newFrom.trim() || !newTo.trim() || Number.isNaN(minutes) || minutes < 0) {
      toast.error('Fill in workcentre, both item codes, and a non-negative minute value');
      return;
    }
    if (newFrom.trim().toUpperCase() === newTo.trim().toUpperCase()) {
      toast.error('From and To items must differ — same-item runs need no changeover');
      return;
    }
    try {
      setSaving(true);
      await apiClient.post('/schedule/setup-matrix', {
        workcentreId: newWc,
        fromItemCode: newFrom.trim().toUpperCase(),
        toItemCode: newTo.trim().toUpperCase(),
        setupMinutes: Math.round(minutes),
      });
      toast.success('Changeover saved');
      setNewFrom('');
      setNewTo('');
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to save changeover'));
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (row: MatrixRow) => {
    try {
      await apiClient.delete(`/schedule/setup-matrix/${row.setupId}`);
      setRows((prev) => prev.filter((r) => r.setupId !== row.setupId));
      toast.success('Changeover removed');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to delete changeover'));
    }
  };

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.workcentreId.toLowerCase().includes(q) ||
        r.fromItemCode.toLowerCase().includes(q) ||
        r.toItemCode.toLowerCase().includes(q)
    );
  }, [rows, filter]);

  return (
    <div className="setup-matrix">
      <div className="setup-matrix-header">
        <div>
          <h3>Changeover Matrix</h3>
          <p>
            Sequence-dependent setup times. When a resource switches from one item to another,
            the engine charges the matrix value instead of the operation&apos;s default setup time.
          </p>
        </div>
        <button className="btn btn-sm" onClick={load} disabled={loading} title="Reload">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="setup-matrix-add">
        <select value={newWc} onChange={(e) => setNewWc(e.target.value)} aria-label="Workcentre">
          <option value="">Workcentre…</option>
          {workcentres.map((wc) => (
            <option key={wc} value={wc}>{wc}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="From item code"
          value={newFrom}
          onChange={(e) => setNewFrom(e.target.value)}
          aria-label="From item code"
        />
        <span className="setup-matrix-arrow">→</span>
        <input
          type="text"
          placeholder="To item code"
          value={newTo}
          onChange={(e) => setNewTo(e.target.value)}
          aria-label="To item code"
        />
        <input
          type="number"
          min={0}
          max={100000}
          value={newMinutes}
          onChange={(e) => setNewMinutes(e.target.value)}
          aria-label="Setup minutes"
          className="setup-matrix-minutes"
        />
        <span className="setup-matrix-unit">min</span>
        <button className="btn btn-sm btn-primary" onClick={addRow} disabled={saving}>
          <Plus size={13} /> {saving ? 'Saving…' : 'Add / Update'}
        </button>
      </div>

      <div className="setup-matrix-toolbar">
        <input
          type="text"
          placeholder="Filter by workcentre or item…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="setup-matrix-count">{visibleRows.length} / {rows.length} rows</span>
      </div>

      <div className="setup-matrix-table-wrap">
        <table className="setup-matrix-table">
          <thead>
            <tr>
              <th>Workcentre</th>
              <th>From item</th>
              <th>To item</th>
              <th className="num">Changeover (min)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.setupId}>
                <td>{row.workcentreId}</td>
                <td className="mono">{row.fromItemCode}</td>
                <td className="mono">{row.toItemCode}</td>
                <td className="num">{row.setupMinutes}</td>
                <td className="actions">
                  <button
                    className="setup-matrix-delete"
                    onClick={() => deleteRow(row)}
                    title="Delete row"
                    aria-label={`Delete ${row.fromItemCode} to ${row.toItemCode}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="setup-matrix-empty">
                  {rows.length === 0
                    ? 'No changeover rows yet. Add item-to-item transitions above — the engine falls back to each operation\'s default setup time until then.'
                    : 'No rows match your filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SetupMatrixEditor;
