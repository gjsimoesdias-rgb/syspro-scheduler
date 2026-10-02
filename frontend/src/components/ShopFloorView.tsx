/**
 * ShopFloorView — read-only shop-floor board (#65), at /shopfloor.
 *
 * Built for tablets and wall screens on the factory floor, still fine on a
 * phone: one column per line (wraps — 1 on a phone, 2 on a tablet, 3–4 on a
 * big screen), large type and touch targets, and each operation marked
 * Now / Next / Done against the clock. Refreshes every 5 minutes; the
 * Now/Next marks update every minute. No editing.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Clock } from 'lucide-react';
import CruxLogo from './CruxLogo';
import './ShopFloorView.css';

interface ShopOp {
  jobId: string;
  opId: string;
  resourceId: string;
  plannedStartDate: string;
  plannedEndDate: string;
}

interface ShopWorkcentre {
  workcentreId: string;
  operations: ShopOp[];
}

interface ShopFloorData {
  date: string;
  workcentres: ShopWorkcentre[];
}

type OpState = 'now' | 'next' | 'done' | 'later';

const API_BASE = (window as any).__APS_CONFIG__?.apiUrl ?? '/api';

/**
 * The screen link (Settings → Shop-floor screen) carries ?key=…. Remember it
 * on this device and take it out of the address bar, so it isn't left on
 * screen or in browser history.
 */
const KEY_STORAGE = 'crux_shopfloor_key';
export function shopfloorKey(): string | null {
  let fromUrl: string | null = null;
  try {
    const url = new URL(window.location.href);
    fromUrl = url.searchParams.get('key');
    if (fromUrl) {
      try { localStorage.setItem(KEY_STORAGE, fromUrl); } catch { /* private mode: keep for this load */ }
      url.searchParams.delete('key');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch { /* ignore */ }
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
}

/** HH:MM, with the weekday when it is not today (multi-day operations). */
const time = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
};
const shortJob = (id: string) => String(id).replace(/^(MRP-)?0+(?=\d)/, '$1');
const opNo = (opId: string) => (/-OP(\d+)$/i.exec(opId)?.[1] ?? opId);
const STATE_LABEL: Record<OpState, string> = { now: 'Now', next: 'Next', done: 'Done', later: '' };

/** Now = running; Next = first one not started yet on that line; Done = ended. */
export function opStates(ops: ShopOp[], now: number): OpState[] {
  let nextGiven = false;
  return ops.map((op) => {
    const s = new Date(op.plannedStartDate).getTime();
    const e = new Date(op.plannedEndDate).getTime();
    if (e <= now) return 'done';
    if (s <= now) return 'now';
    if (!nextGiven) { nextGiven = true; return 'next'; }
    return 'later';
  });
}

const ShopFloorView: React.FC = () => {
  const [data, setData] = useState<ShopFloorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showDone, setShowDone] = useState<Record<string, boolean>>({});
  const [key] = useState(() => shopfloorKey());

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/shopfloor/today`, { headers: key ? { 'X-Shopfloor-Key': key } : {} })
      .then(async (r) => {
        if (r.status === 401) {
          throw new Error('This screen needs the shop-floor link. Ask an admin for it (Settings → Shop-floor screen) and open it on this device once.');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ShopFloorData) => { setData(d); setLoadedAt(new Date()); setLoading(false); })
      .catch((e: any) => { setError(e.message); setLoading(false); });
  }, [key]);

  useEffect(() => {
    load();
    const refresh = setInterval(load, 5 * 60 * 1000);
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  const lines = useMemo(
    () => [...(data?.workcentres || [])].sort((a, b) => a.workcentreId.localeCompare(b.workcentreId)),
    [data]
  );

  return (
    <div className="sf-root">
      <header className="sf-header">
        <CruxLogo variant="inline" height={22} className="sf-logo" />
        <div className="sf-title">
          <h1>Shop floor</h1>
          <span className="sf-date">
            {data?.date ? new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : ''}
          </span>
        </div>
        <span className="sf-clock" aria-label="Current time">
          <Clock size={16} aria-hidden="true" /> {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <button className="sf-refresh" onClick={load} aria-label="Refresh" disabled={loading}>
          <RefreshCw size={18} aria-hidden="true" className={loading ? 'sf-spin' : ''} />
          <span>Refresh</span>
        </button>
      </header>

      {error && (
        <div className="sf-message sf-error" role="alert">
          Could not load the schedule ({error}). <button onClick={load}>Try again</button>
        </div>
      )}
      {!error && loading && !data && <div className="sf-message">Loading today&apos;s schedule…</div>}
      {!error && data && lines.length === 0 && <div className="sf-message">No operations scheduled for today.</div>}

      <main className="sf-board">
        {lines.map((wc) => {
          const states = opStates(wc.operations, now);
          const running = states.includes('now');
          const doneCount = states.filter((x) => x === 'done').length;
          return (
            <section key={wc.workcentreId} className={`sf-line ${running ? 'is-running' : ''}`} aria-label={`Line ${wc.workcentreId}`}>
              <h2 className="sf-line-title">
                <span>{wc.workcentreId}</span>
                <span className="sf-line-meta">{wc.operations.length} op{wc.operations.length === 1 ? '' : 's'}{running ? ' · running' : ''}</span>
              </h2>
              <ol className="sf-op-list">
                {doneCount > 0 && (
                  <li className="sf-done-toggle">
                    <button onClick={() => setShowDone((m) => ({ ...m, [wc.workcentreId]: !m[wc.workcentreId] }))} aria-expanded={!!showDone[wc.workcentreId]}>
                      {showDone[wc.workcentreId] ? 'Hide' : 'Show'} {doneCount} done earlier today
                    </button>
                  </li>
                )}
                {wc.operations.map((op, i) => {
                  const st = states[i];
                  if (st === 'done' && !showDone[wc.workcentreId]) return null;
                  return (
                    <li key={`${op.jobId}-${op.opId}`} className={`sf-op sf-op--${st}`}>
                      <div className="sf-op-time">{time(op.plannedStartDate)} – {time(op.plannedEndDate)}</div>
                      {STATE_LABEL[st] && <span className={`sf-badge sf-badge--${st}`}>{STATE_LABEL[st]}</span>}
                      <div className="sf-op-job">Job {shortJob(op.jobId)} <span className="sf-op-no">op {opNo(op.opId)}</span></div>
                      {op.resourceId && <div className="sf-op-machine">{op.resourceId}</div>}
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </main>

      <footer className="sf-footer">
        {loadedAt ? `Updated ${loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refreshes every 5 minutes` : ''}
      </footer>
    </div>
  );
};

export default ShopFloorView;
