/**
 * ShopFloorView — mobile-first read-only shop-floor schedule (#65).
 *
 * Accessible at the /shopfloor route. Designed for phones/tablets on the
 * factory floor. Shows today's ops per workcentre in a simple card layout.
 *
 * No drag, no editing — purely informational.
 */
import React, { useEffect, useState } from 'react';
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

const API_BASE = (window as any).__APS_CONFIG__?.apiUrl ?? '/api';

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

const ShopFloorView: React.FC = () => {
  const [data, setData] = useState<ShopFloorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/shopfloor/today`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ShopFloorData) => { setData(d); setLoading(false); })
      .catch((e: any) => { setError(e.message); setLoading(false); });
  };

  useEffect(() => {
    load();
    // Auto-refresh every 5 minutes
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <div className="sf-loading">Loading today&apos;s schedule…</div>;
  if (error)   return <div className="sf-error">Error: {error} <button onClick={load}>Retry</button></div>;
  if (!data || !data.workcentres.length) {
    return <div className="sf-empty">No operations scheduled for today.</div>;
  }

  return (
    <div className="sf-root">
      <header className="sf-header">
        <h1>Shop Floor — {data.date}</h1>
        <button className="sf-refresh" onClick={load} aria-label="Refresh">↺</button>
      </header>

      {data.workcentres.map((wc) => (
        <section key={wc.workcentreId} className="sf-wc">
          <h2 className="sf-wc-title">{wc.workcentreId}</h2>
          <ul className="sf-op-list">
            {wc.operations.map((op) => (
              <li key={`${op.jobId}-${op.opId}`} className="sf-op-card">
                <div className="sf-op-job">Job {op.jobId}</div>
                <div className="sf-op-time">{fmt(op.plannedStartDate)} – {fmt(op.plannedEndDate)}</div>
                {op.resourceId && <div className="sf-op-resource">{op.resourceId}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

export default ShopFloorView;
