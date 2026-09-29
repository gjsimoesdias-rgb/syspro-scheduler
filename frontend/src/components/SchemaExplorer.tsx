/**
 * SchemaExplorer — live database-diagram modal.
 *
 * Opened from the HOME ribbon (next to Refresh). Fetches the live schema of
 * every connected database (SYSPRO + Scheduler) via `statusService.getSchema`
 * and renders an interactive ER-style diagram:
 *
 *   • Left sidebar — pick a database, search/filter its tables & views, and
 *     click to drop an entity onto the canvas.
 *   • Canvas — draggable entity boxes (columns, PK/FK badges) with foreign-key
 *     connector lines drawn between whatever tables are currently on screen.
 *     Pan by dragging the background, zoom with the mouse wheel.
 *
 * No user data is read — only the system catalog. Everything is client-side
 * once the schema payload has loaded, so panning/zooming/dragging is instant.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Table2, Eye, KeyRound, Database, RefreshCw, Search, X, Link2, Maximize2,
} from 'lucide-react';
import { statusService, apiErrorMessage } from '../services/api';
import type { SchemaDatabase, SchemaObject, SchemaResponse } from '../services/api';
import './SchemaExplorer.css';

interface SchemaExplorerProps {
  open: boolean;
  onClose: () => void;
}

type TypeFilter = 'all' | 'table' | 'view';

interface DiagramNode {
  key: string;        // `${schema}.${name}` within the active database
  obj: SchemaObject;
  x: number;
  y: number;
}

const NODE_WIDTH = 240;
const GRID_GAP_X = 300;
const GRID_GAP_Y = 40;
const objectKey = (o: { schema: string; name: string }) => `${o.schema}.${o.name}`;

const SchemaExplorer: React.FC<SchemaExplorerProps> = ({ open, onClose }) => {
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeDb, setActiveDb] = useState(0);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  // Diagram state — nodes keyed by `${schema}.${name}` within the active DB.
  const [nodes, setNodes] = useState<DiagramNode[]>([]);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(1);

  // Measured node sizes (heights vary with column count) used for FK routing.
  const nodeElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragNode = useRef<{ key: string; offX: number; offY: number } | null>(null);
  const panDrag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ── Load schema when the modal opens ─────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await statusService.getSchema();
      setSchema(data);
      setActiveDb(0);
      setNodes([]);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the database schema.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !schema && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset transient view state when switching database.
  useEffect(() => {
    setNodes([]);
    setPan({ x: 40, y: 40 });
    setZoom(1);
    setSearch('');
    setTypeFilter('all');
  }, [activeDb]);

  const db: SchemaDatabase | undefined = schema?.databases[activeDb];

  const filteredObjects = useMemo(() => {
    if (!db) return [];
    const q = search.trim().toLowerCase();
    return db.objects.filter((o) => {
      if (typeFilter !== 'all' && o.type !== typeFilter) return false;
      if (!q) return true;
      return `${o.schema}.${o.name}`.toLowerCase().includes(q);
    });
  }, [db, search, typeFilter]);

  const nodeKeys = useMemo(() => new Set(nodes.map((n) => n.key)), [nodes]);

  // ── Node add / remove / layout ───────────────────────────────────────────
  const nextGridPosition = useCallback((count: number) => {
    const cols = 4;
    const col = count % cols;
    const row = Math.floor(count / cols);
    return { x: col * GRID_GAP_X + 20, y: row * (260 + GRID_GAP_Y) + 20 };
  }, []);

  const addNode = useCallback(
    (obj: SchemaObject) => {
      setNodes((prev) => {
        const key = objectKey(obj);
        if (prev.some((n) => n.key === key)) return prev.filter((n) => n.key !== key); // toggle off
        const pos = nextGridPosition(prev.length);
        return [...prev, { key, obj, x: pos.x, y: pos.y }];
      });
    },
    [nextGridPosition]
  );

  const addRelated = useCallback(() => {
    if (!db) return;
    setNodes((prev) => {
      const present = new Set(prev.map((n) => n.key));
      const wanted = new Set<string>();
      for (const rel of db.relationships) {
        const from = `${rel.fromSchema}.${rel.fromTable}`;
        const to = `${rel.toSchema}.${rel.toTable}`;
        if (present.has(from)) wanted.add(to);
        if (present.has(to)) wanted.add(from);
      }
      const byKey = new Map(db.objects.map((o) => [objectKey(o), o]));
      let count = prev.length;
      const additions: DiagramNode[] = [];
      wanted.forEach((k) => {
        if (present.has(k)) return;
        const obj = byKey.get(k);
        if (!obj) return;
        const pos = nextGridPosition(count++);
        additions.push({ key: k, obj, x: pos.x, y: pos.y });
      });
      return [...prev, ...additions];
    });
  }, [db, nextGridPosition]);

  const clearCanvas = useCallback(() => setNodes([]), []);

  // Columns involved in a foreign key (either side) → rendered with a link badge.
  const fkColumns = useMemo(() => {
    const m = new Map<string, Set<string>>(); // objectKey → set of column names
    if (!db) return m;
    for (const rel of db.relationships) {
      const from = `${rel.fromSchema}.${rel.fromTable}`;
      const to = `${rel.toSchema}.${rel.toTable}`;
      if (!m.has(from)) m.set(from, new Set());
      if (!m.has(to)) m.set(to, new Set());
      m.get(from)!.add(rel.fromColumn);
      m.get(to)!.add(rel.toColumn);
    }
    return m;
  }, [db]);

  // ── Measure node sizes for edge routing ──────────────────────────────────
  useLayoutEffect(() => {
    const next = new Map<string, { w: number; h: number }>();
    let changed = nodes.length !== sizes.size;
    for (const n of nodes) {
      const el = nodeElRefs.current.get(n.key);
      if (el) {
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        next.set(n.key, { w, h });
        const prev = sizes.get(n.key);
        if (!prev || prev.w !== w || prev.h !== h) changed = true;
      }
    }
    if (changed) setSizes(next);
  }, [nodes, sizes]);

  // Edges between nodes currently on canvas.
  const edges = useMemo(() => {
    if (!db) return [];
    const posByKey = new Map(nodes.map((n) => [n.key, n]));
    const out: { id: string; d: string; mx: number; my: number }[] = [];
    db.relationships.forEach((rel, i) => {
      const fromKey = `${rel.fromSchema}.${rel.fromTable}`;
      const toKey = `${rel.toSchema}.${rel.toTable}`;
      const a = posByKey.get(fromKey);
      const b = posByKey.get(toKey);
      if (!a || !b) return;
      const sa = sizes.get(fromKey) || { w: NODE_WIDTH, h: 120 };
      const sb = sizes.get(toKey) || { w: NODE_WIDTH, h: 120 };
      const ax = a.x + sa.w / 2;
      const ay = a.y + sa.h / 2;
      const bx = b.x + sb.w / 2;
      const by = b.y + sb.h / 2;
      // Attach on the facing horizontal edge of each box.
      const a2 = ax < bx ? a.x + sa.w : a.x;
      const b2 = ax < bx ? b.x : b.x + sb.w;
      const dx = Math.abs(b2 - a2) * 0.4 + 20;
      const c1x = ax < bx ? a2 + dx : a2 - dx;
      const c2x = ax < bx ? b2 - dx : b2 + dx;
      out.push({
        id: `${rel.name}-${i}`,
        d: `M ${a2} ${ay} C ${c1x} ${ay}, ${c2x} ${by}, ${b2} ${by}`,
        mx: (a2 + b2) / 2,
        my: (ay + by) / 2,
      });
    });
    return out;
  }, [db, nodes, sizes]);

  const canvasBounds = useMemo(() => {
    let maxX = 800;
    let maxY = 600;
    for (const n of nodes) {
      const s = sizes.get(n.key) || { w: NODE_WIDTH, h: 260 };
      maxX = Math.max(maxX, n.x + s.w + 80);
      maxY = Math.max(maxY, n.y + s.h + 80);
    }
    return { w: maxX, h: maxY };
  }, [nodes, sizes]);

  // ── Pointer interactions: drag nodes / pan background / wheel-zoom ─────────
  const onNodeMouseDown = (e: React.MouseEvent, key: string) => {
    e.stopPropagation();
    const node = nodes.find((n) => n.key === key);
    if (!node) return;
    dragNode.current = {
      key,
      offX: e.clientX / zoom - node.x,
      offY: e.clientY / zoom - node.y,
    };
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    panDrag.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
  };

  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent) => {
      if (dragNode.current) {
        const { key, offX, offY } = dragNode.current;
        const nx = e.clientX / zoom - offX;
        const ny = e.clientY / zoom - offY;
        setNodes((prev) => prev.map((n) => (n.key === key ? { ...n, x: nx, y: ny } : n)));
      } else if (panDrag.current) {
        const p = panDrag.current;
        setPan({ x: p.origX + (e.clientX - p.startX), y: p.origY + (e.clientY - p.startY) });
      }
    };
    const onUp = () => {
      dragNode.current = null;
      panDrag.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [open, zoom]);

  const onWheel = (e: React.WheelEvent) => {
    if (!canvasRef.current) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = Math.min(2.5, Math.max(0.25, zoom * factor));
    // Keep the point under the cursor stationary while zooming.
    setPan((prev) => ({
      x: cursorX - (cursorX - prev.x) * (newZoom / zoom),
      y: cursorY - (cursorY - prev.y) * (newZoom / zoom),
    }));
    setZoom(newZoom);
  };

  const resetView = () => {
    setPan({ x: 40, y: 40 });
    setZoom(1);
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="schema-explorer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Database diagram"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="schema-explorer-header">
          <h2><Database size={16} aria-hidden="true" /> Database Diagram</h2>
          <div className="schema-explorer-header-meta">
            {schema && (
              <span className="schema-explorer-generated">
                Live schema{schema.generatedAt ? ` · ${new Date(schema.generatedAt).toLocaleTimeString()}` : ''}
              </span>
            )}
            <button className="btn btn-sm" onClick={load} disabled={loading} title="Re-introspect the database">
              <RefreshCw size={13} aria-hidden="true" /> Refresh
            </button>
            <button className="close-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="schema-explorer-body">
          {/* Sidebar */}
          <aside className="schema-explorer-sidebar">
            {schema && schema.databases.length > 0 && (
              <div className="schema-db-tabs">
                {schema.databases.map((d, i) => (
                  <button
                    key={d.name + i}
                    className={`schema-db-tab ${i === activeDb ? 'active' : ''}`}
                    onClick={() => setActiveDb(i)}
                    title={`${d.tableCount} tables · ${d.viewCount} views`}
                  >
                    <Database size={12} aria-hidden="true" /> {d.name}
                    <span className={`schema-db-role role-${d.role}`}>{d.role}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="schema-search">
              <Search size={13} aria-hidden="true" />
              <input
                type="text"
                placeholder="Search tables & views…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="schema-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="schema-type-filter">
              {(['all', 'table', 'view'] as TypeFilter[]).map((t) => (
                <button
                  key={t}
                  className={typeFilter === t ? 'active' : ''}
                  onClick={() => setTypeFilter(t)}
                >
                  {t === 'all' ? 'All' : t === 'table' ? 'Tables' : 'Views'}
                </button>
              ))}
            </div>

            <div className="schema-object-list">
              {db &&
                filteredObjects.map((o) => {
                  const key = objectKey(o);
                  const on = nodeKeys.has(key);
                  return (
                    <button
                      key={key}
                      className={`schema-object-item ${on ? 'on-canvas' : ''}`}
                      onClick={() => addNode(o)}
                      title={`${o.columns.length} columns${o.rows != null ? ` · ~${o.rows.toLocaleString()} rows` : ''}`}
                    >
                      {o.type === 'view'
                        ? <Eye size={13} className="schema-obj-icon view" aria-hidden="true" />
                        : <Table2 size={13} className="schema-obj-icon table" aria-hidden="true" />}
                      <span className="schema-object-name">
                        {o.schema !== 'dbo' && <span className="schema-obj-schema">{o.schema}.</span>}
                        {o.name}
                      </span>
                      <span className="schema-object-cols">{o.columns.length}</span>
                    </button>
                  );
                })}
              {db && filteredObjects.length === 0 && (
                <p className="schema-empty-hint">No tables or views match “{search}”.</p>
              )}
            </div>

            {db && (
              <div className="schema-sidebar-footer">
                <span>{filteredObjects.length} shown · {nodes.length} on canvas</span>
              </div>
            )}
          </aside>

          {/* Canvas */}
          <div className="schema-canvas-wrap">
            <div className="schema-canvas-toolbar">
              <button className="btn btn-sm" onClick={addRelated} disabled={!nodes.length} title="Add tables linked by foreign keys">
                <Link2 size={13} aria-hidden="true" /> Show related
              </button>
              <button className="btn btn-sm" onClick={clearCanvas} disabled={!nodes.length}>Clear</button>
              <button className="btn btn-sm" onClick={resetView} title="Reset pan & zoom">
                <Maximize2 size={13} aria-hidden="true" /> Reset view
              </button>
              <span className="schema-zoom-label">{Math.round(zoom * 100)}%</span>
            </div>

            <div
              className="schema-canvas"
              ref={canvasRef}
              onMouseDown={onCanvasMouseDown}
              onWheel={onWheel}
            >
              {loading && <div className="schema-canvas-state"><span className="spinner" /> Introspecting database…</div>}
              {error && !loading && (
                <div className="schema-canvas-state error">
                  <p>{error}</p>
                  <button className="btn btn-sm" onClick={load}>Try again</button>
                </div>
              )}
              {!loading && !error && nodes.length === 0 && (
                <div className="schema-canvas-state">
                  <Database size={28} aria-hidden="true" />
                  <p>Click tables or views on the left to build a diagram.</p>
                  <p className="muted">Drag the background to pan · scroll to zoom · drag a box to move it.</p>
                </div>
              )}

              <div
                className="schema-canvas-inner"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  width: canvasBounds.w,
                  height: canvasBounds.h,
                }}
              >
                {/* FK edges */}
                <svg
                  className="schema-edges"
                  width={canvasBounds.w}
                  height={canvasBounds.h}
                >
                  <defs>
                    <marker id="schema-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
                            orient="auto" markerUnits="strokeWidth">
                      <path d="M0,0 L7,3 L0,6 Z" className="schema-arrowhead" />
                    </marker>
                  </defs>
                  {edges.map((e) => (
                    <path key={e.id} d={e.d} className="schema-edge" markerEnd="url(#schema-arrow)" />
                  ))}
                </svg>

                {/* Entity boxes */}
                {nodes.map((n) => {
                  const fkCols = fkColumns.get(n.key);
                  return (
                    <div
                      key={n.key}
                      className={`schema-node ${n.obj.type}`}
                      ref={(el) => {
                        if (el) nodeElRefs.current.set(n.key, el);
                        else nodeElRefs.current.delete(n.key);
                      }}
                      style={{ left: n.x, top: n.y, width: NODE_WIDTH }}
                    >
                      <div className="schema-node-header" onMouseDown={(e) => onNodeMouseDown(e, n.key)}>
                        {n.obj.type === 'view'
                          ? <Eye size={12} aria-hidden="true" />
                          : <Table2 size={12} aria-hidden="true" />}
                        <span className="schema-node-title">
                          {n.obj.schema !== 'dbo' && <span className="schema-node-schema">{n.obj.schema}.</span>}
                          {n.obj.name}
                        </span>
                        <button
                          className="schema-node-remove"
                          onClick={(e) => { e.stopPropagation(); addNode(n.obj); }}
                          aria-label="Remove from diagram"
                        >✕</button>
                      </div>
                      {n.obj.rows != null && (
                        <div className="schema-node-sub">~{n.obj.rows.toLocaleString()} rows · {n.obj.columns.length} cols</div>
                      )}
                      <div className="schema-node-cols">
                        {n.obj.columns.map((c) => (
                          <div key={c.name} className={`schema-col ${c.pk ? 'pk' : ''}`}>
                            <span className="schema-col-name">
                              {c.pk && <KeyRound size={10} className="schema-col-key" aria-hidden="true" />}
                              {!c.pk && fkCols?.has(c.name) && <Link2 size={10} className="schema-col-fk" aria-hidden="true" />}
                              {c.name}
                            </span>
                            <span className="schema-col-type">{c.type}{c.nullable ? '' : ' ·'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SchemaExplorer;
