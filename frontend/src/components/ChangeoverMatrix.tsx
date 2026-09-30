/**
 * ChangeoverMatrix — grid editor for sequence-dependent changeover (setup)
 * times between finished goods. Replaces the row-by-row SetupMatrixEditor.
 *
 * Values are GLOBAL (apply to all workcentres) and are written to the same
 * dbo.sch_SetupMatrix table the scheduler already reads, so anything entered
 * here is automatically charged as setup time on that item -> item transition
 * during schedule generation (greedy + CP-SAT). Units are minutes; 0 clears the
 * cell. Global rows are stored with the '*' workcentre sentinel and the backend
 * maps them to generic (all-workcentre) lookups.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Save, RotateCcw, Grid3x3 } from 'lucide-react';
import { apiClient, apiErrorMessage } from '../services/api';
import './ChangeoverMatrix.css';

interface FinishedGood {
  stockCode: string;
  description: string;
}
interface MatrixRow {
  fromClass: string;
  toClass: string;
  setupMinutes: number;
}

const MAX_AXIS = 60; // cap rendered rows/cols to keep the DOM light — refine search to see more
const keyOf = (from: string, to: string) => `${from}||${to}`;

const ChangeoverMatrix: React.FC = () => {
  const [goods, setGoods] = useState<FinishedGood[]>([]);
  const [saved, setSaved] = useState<Map<string, number>>(new Map());
  const [edits, setEdits] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowSearch, setRowSearch] = useState('');
  const [colSearch, setColSearch] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [fillValue, setFillValue] = useState('30');
  const [warning, setWarning] = useState<string>('');
  const [loadError, setLoadError] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pcRes, mxRes] = await Promise.all([
        apiClient.get('/schedule/product-classes'),
        apiClient.get('/schedule/class-changeover'),
      ]);
      const items: FinishedGood[] = (pcRes.data?.classes || [])
        .map((c: any) => String(c || '').toUpperCase().trim())
        .filter(Boolean)
        .map((code: string) => ({ stockCode: code, description: '' }));
      const m = new Map<string, number>();
      for (const r of (mxRes.data?.rows || []) as MatrixRow[]) {
        m.set(
          keyOf(String(r.fromClass).toUpperCase(), String(r.toClass).toUpperCase()),
          r.setupMinutes
        );
      }
      setGoods(items);
      setWarning(String(pcRes.data?.warning || ''));
      setLoadError('');
      setSaved(m);
      setEdits(new Map());
    } catch (err: any) {
      setWarning('');
      const status = err?.response?.status;
      setLoadError(
        status === 401 || status === 403
          ? 'Your session has expired — sign in again, then reload.'
          : apiErrorMessage(err, 'Couldn\'t reach the scheduler backend.')
      );
      toast.error(apiErrorMessage(err, 'Failed to load changeover matrix'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Effective (saved + pending edits) values, dropping zeroes.
  const effective = useMemo(() => {
    const e = new Map(saved);
    edits.forEach((v, k) => {
      if (v > 0) e.set(k, v);
      else e.delete(k);
    });
    return e;
  }, [saved, edits]);

  // Codes that currently carry a value — used by the "only set" filter.
  const [setFroms, setTos] = useMemo(() => {
    const f = new Set<string>();
    const t = new Set<string>();
    effective.forEach((_v, k) => {
      const [from, to] = k.split('||');
      f.add(from);
      t.add(to);
    });
    return [f, t];
  }, [effective]);

  const cellValue = (from: string, to: string): number => {
    const k = keyOf(from, to);
    if (edits.has(k)) return edits.get(k)!;
    return saved.get(k) ?? 0;
  };

  const setCell = (from: string, to: string, raw: string) => {
    if (from === to) return;
    const k = keyOf(from, to);
    const n = Math.max(0, Math.round(Number(raw) || 0));
    const base = saved.get(k) ?? 0;
    setEdits((prev) => {
      const next = new Map(prev);
      if (n === base) next.delete(k);
      else next.set(k, n);
      return next;
    });
  };

  const matchG = (g: FinishedGood, q: string) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return g.stockCode.toLowerCase().includes(s) || g.description.toLowerCase().includes(s);
  };

  const rowItemsAll = useMemo(
    () => goods.filter((g) => matchG(g, rowSearch) && (!onlySet || setFroms.has(g.stockCode))),
    [goods, rowSearch, onlySet, setFroms]
  );
  const colItemsAll = useMemo(
    () => goods.filter((g) => matchG(g, colSearch) && (!onlySet || setTos.has(g.stockCode))),
    [goods, colSearch, onlySet, setTos]
  );
  const rowItems = rowItemsAll.slice(0, MAX_AXIS);
  const colItems = colItemsAll.slice(0, MAX_AXIS);

  const save = async () => {
    if (edits.size === 0) return;
    setSaving(true);
    try {
      const rows = Array.from(edits.entries()).map(([k, v]) => {
        const [fromClass, toClass] = k.split('||');
        return { fromClass, toClass, setupMinutes: v };
      });
      const res = await apiClient.post('/schedule/class-changeover/bulk', { rows });
      setSaved((prev) => {
        const next = new Map(prev);
        edits.forEach((v, k) => {
          if (v > 0) next.set(k, v);
          else next.delete(k);
        });
        return next;
      });
      setEdits(new Map());
      const n = res.data?.applied ?? rows.length;
      toast.success(`Saved ${n} changeover${n === 1 ? '' : 's'} — now included in scheduling`);
    } catch (err: any) {
      toast.error(apiErrorMessage(err, 'Failed to save changeover matrix'));
    } finally {
      setSaving(false);
    }
  };

  // Fill every empty, off-diagonal, currently-visible cell with the fill value.
  const fillBlanks = () => {
    const v = Math.max(0, Math.round(Number(fillValue) || 0));
    if (v <= 0) {
      toast.error('Enter a positive minute value to fill');
      return;
    }
    setEdits((prev) => {
      const next = new Map(prev);
      let count = 0;
      for (const r of rowItems) {
        for (const c of colItems) {
          if (r.stockCode === c.stockCode) continue;
          const k = keyOf(r.stockCode, c.stockCode);
          const current = next.has(k) ? next.get(k)! : saved.get(k) ?? 0;
          if (current === 0) {
            const base = saved.get(k) ?? 0;
            if (v === base) next.delete(k);
            else next.set(k, v);
            count++;
          }
        }
      }
      if (count === 0) toast('No empty visible cells to fill', { icon: 'ℹ️' });
      return next;
    });
  };

  const dirty = edits.size;

  return (
    <div className="cm-wrap">
      <div className="cm-header">
        <div className="cm-title">
          <Grid3x3 size={16} aria-hidden="true" />
          <div>
            <h3>Changeover Matrix</h3>
            <p>
              Sequence-dependent setup time (minutes) between product classes. Every finished good
              inherits its class&apos;s changeover; charged automatically during scheduling.
              From (rows) → To (columns).
            </p>
          </div>
        </div>
        <div className="cm-actions">
          <button className="cm-btn" onClick={load} disabled={loading || saving} title="Reload">
            <RefreshCw size={13} className={loading ? 'cm-spin' : ''} aria-hidden="true" /> Reload
          </button>
          <button
            className="cm-btn"
            onClick={() => setEdits(new Map())}
            disabled={dirty === 0 || saving}
            title="Discard unsaved edits"
          >
            <RotateCcw size={13} aria-hidden="true" /> Discard
          </button>
          <button className="cm-btn cm-btn-primary" onClick={save} disabled={dirty === 0 || saving}>
            <Save size={13} aria-hidden="true" /> {saving ? 'Saving…' : `Save${dirty ? ` (${dirty})` : ''}`}
          </button>
        </div>
      </div>

      <div className="cm-toolbar">
        <input
          className="cm-input"
          placeholder="Filter From classes…"
          value={rowSearch}
          onChange={(e) => setRowSearch(e.target.value)}
        />
        <input
          className="cm-input"
          placeholder="Filter To classes…"
          value={colSearch}
          onChange={(e) => setColSearch(e.target.value)}
        />
        <label className="cm-check">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} />
          Only items with a value
        </label>
        <div className="cm-fill">
          <input
            className="cm-input cm-input-sm"
            type="number"
            min={0}
            value={fillValue}
            onChange={(e) => setFillValue(e.target.value)}
            title="Minutes"
          />
          <button className="cm-btn" onClick={fillBlanks} disabled={saving} title="Fill empty visible cells">
            Fill blanks
          </button>
        </div>
      </div>

      {warning && !loading ? (
        <div className="cm-banner cm-banner-warn" role="status">{warning}</div>
      ) : null}
      {loading ? (
        <div className="cm-empty">Loading finished goods…</div>
      ) : loadError ? (
        <div className="cm-empty cm-empty-error">
          {loadError}
          <div>
            <button className="cm-btn" onClick={load} style={{ marginTop: 8 }}>Try again</button>
          </div>
        </div>
      ) : goods.length === 0 ? (
        <div className="cm-empty">
          Connected, but no product classes were returned. Assign a ProductClass to your
          finished goods (PartCategory = M) in SYSPRO, then reload.
        </div>
      ) : rowItems.length === 0 || colItems.length === 0 ? (
        <div className="cm-empty">No items match the current filters.</div>
      ) : (
        <>
          <div className="cm-meta">
            Showing {rowItems.length} of {rowItemsAll.length} From-classes × {colItems.length} of{' '}
            {colItemsAll.length} To-classes
            {(rowItemsAll.length > MAX_AXIS || colItemsAll.length > MAX_AXIS) && (
              <span className="cm-warn"> — refine the filters to narrow beyond {MAX_AXIS} per axis</span>
            )}
            {dirty > 0 && <span className="cm-dirty"> · {dirty} unsaved</span>}
          </div>
          <div className="cm-grid-scroll aps-scroll">
            <table className="cm-grid">
              <thead>
                <tr>
                  <th className="cm-corner" title="From (row) → To (column)">
                    From \ To
                  </th>
                  {colItems.map((c) => (
                    <th key={c.stockCode} className="cm-colhead" title={`${c.stockCode} — ${c.description}`}>
                      <span>{c.stockCode}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowItems.map((r) => (
                  <tr key={r.stockCode}>
                    <th className="cm-rowhead" title={`${r.stockCode} — ${r.description}`}>
                      <span className="cm-code">{r.stockCode}</span>
                      <span className="cm-desc">{r.description}</span>
                    </th>
                    {colItems.map((c) => {
                      if (r.stockCode === c.stockCode) {
                        return (
                          <td key={c.stockCode} className="cm-diag" title="Same item — no changeover">
                            —
                          </td>
                        );
                      }
                      const k = keyOf(r.stockCode, c.stockCode);
                      const val = cellValue(r.stockCode, c.stockCode);
                      const isDirty = edits.has(k);
                      return (
                        <td key={c.stockCode} className={`cm-cell${isDirty ? ' cm-cell-dirty' : ''}`}>
                          <input
                            type="number"
                            min={0}
                            value={val === 0 ? '' : val}
                            placeholder="0"
                            className={val > 0 ? 'cm-has-val' : ''}
                            onChange={(e) => setCell(r.stockCode, c.stockCode, e.target.value)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default ChangeoverMatrix;
