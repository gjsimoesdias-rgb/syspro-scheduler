/**
 * BomTreeView — Structure & Routings explorer.
 *
 * Like the Job Tree, but driven purely from SYSPRO's BOM tables: the full
 * multi-level structure (BomStructure) with each node's routing operations
 * (BomOperations) inline. Read-only browsing — shows every component,
 * purchased leaf parts included.
 */
import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Layers, Search, ChevronRight, ChevronDown, Package, PackageCheck,
  Wrench, ListCollapse, ListTree,
} from 'lucide-react';
import { apiClient, apiErrorMessage } from '../services/api';
import './BomTreeView.css';

interface BomOp {
  operation: string;
  workcentreId: string;
  setupMinutes: number;
  unitRunMinutes: number;
}

interface BomNode {
  stockCode: string;
  description: string;
  qtyPer: number;
  level: number;
  hasRouting: boolean;
  operations: BomOp[];
  children: BomNode[];
  truncated?: boolean;
}

interface BomTreeResponse {
  root: BomNode;
  nodeCount: number;
  warnings: string[];
}

interface StockHit {
  stockCode: string;
  description: string;
  hasRouting: number;
}

const nodeMinutes = (n: BomNode) =>
  n.operations.reduce((s, o) => s + o.setupMinutes + o.unitRunMinutes, 0);

const fmtMin = (m: number) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10}h` : `${m}m`);

const BomTreeView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [tree, setTree] = useState<BomTreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim();
    if (q.length < 2) {
      toast.error('Type at least 2 characters to search stock codes');
      return;
    }
    try {
      setSearching(true);
      setNotice(null);
      const res = await apiClient.get('/schedule/ctp/stock-search', { params: { q } });
      const items = res.data?.items || [];
      setHits(items);
      if (!items.length) {
        // Not in InvMaster search — but it may still be a structure parent.
        setNotice(`No InvMaster matches for "${q}" — trying a direct structure load…`);
        await load(q.toUpperCase());
      }
    } catch (err: any) {
      setNotice(apiErrorMessage(err, 'Stock code search failed'));
    } finally {
      setSearching(false);
    }
  };

  const load = async (stockCode: string) => {
    try {
      setLoading(true);
      setHits([]);
      const res = await apiClient.get(`/schedule/bom-tree/${encodeURIComponent(stockCode)}`);
      setTree(res.data);
      setCollapsed(new Set()); // expand everything on load
      const n = res.data?.nodeCount ?? 0;
      const root = res.data?.root;
      if (root && !root.children?.length && !root.operations?.length) {
        setNotice(
          `${stockCode}: nothing found — no components under it in BomStructure and no routing in BomOperations. ` +
          'Check the code is a structure parent (ParentPart) in this company database.'
        );
      } else {
        setNotice(null);
        toast.success(`${stockCode}: ${n} component${n === 1 ? '' : 's'} in structure`);
      }
    } catch (err: any) {
      setNotice(apiErrorMessage(err, `Could not load structure for ${stockCode}`));
    } finally {
      setLoading(false);
    }
  };

  // Collect all node keys so expand/collapse-all works.
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (n: BomNode, path: string) => {
      const key = `${path}/${n.stockCode}`;
      keys.push(key);
      n.children.forEach((c) => walk(c, key));
    };
    if (tree?.root) walk(tree.root, '');
    return keys;
  }, [tree]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderOps = (node: BomNode) => (
    <div className="bom-ops" style={{ marginLeft: 26 + node.level * 18 }}>
      <div className="bom-ops-head">
        <span>Op</span><span>Workcentre</span><span className="num">Setup</span><span className="num">Run (unit)</span>
      </div>
      {node.operations.map((op, i) => (
        <div className="bom-ops-row" key={`${op.operation}-${i}`}>
          <span className="mono">{op.operation}</span>
          <span>{op.workcentreId}</span>
          <span className="num">{fmtMin(op.setupMinutes)}</span>
          <span className="num">{fmtMin(op.unitRunMinutes)}</span>
        </div>
      ))}
    </div>
  );

  const renderNode = (node: BomNode, path: string): React.ReactNode => {
    const key = `${path}/${node.stockCode}`;
    const isCollapsed = collapsed.has(key);
    const expandable = node.children.length > 0 || node.operations.length > 0;
    const mins = nodeMinutes(node);

    return (
      <React.Fragment key={key}>
        <div
          className={`bom-row ${node.level === 0 ? 'root' : ''}`}
          style={{ paddingLeft: 6 + node.level * 18 }}
          onClick={() => expandable && toggle(key)}
          role={expandable ? 'button' : undefined}
          title={expandable ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
        >
          <span className="bom-chevron">
            {expandable ? (isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />) : <span className="bom-chevron-spacer" />}
          </span>
          <span className={`bom-icon ${node.hasRouting ? 'made' : 'bought'}`}>
            {node.hasRouting ? <PackageCheck size={13} /> : <Package size={13} />}
          </span>
          <span className="bom-code mono">{node.stockCode}</span>
          {node.description && <span className="bom-desc">{node.description}</span>}
          {node.level > 0 && <span className="bom-chip qty">×{node.qtyPer}</span>}
          {node.hasRouting ? (
            <span className="bom-chip ops">
              <Wrench size={10} /> {node.operations.length} op{node.operations.length === 1 ? '' : 's'} · {fmtMin(mins)}
            </span>
          ) : (
            <span className="bom-chip bought">bought-out</span>
          )}
          {node.truncated && <span className="bom-chip trunc">truncated</span>}
        </div>
        {!isCollapsed && node.operations.length > 0 && renderOps(node)}
        {!isCollapsed && node.children.map((c) => renderNode(c, key))}
      </React.Fragment>
    );
  };

  return (
    <div className="bom-panel">
      <div className="bom-header">
        <h3><Layers size={15} aria-hidden="true" /> Structure &amp; Routings</h3>
        <p>
          Browse the full multi-level bill of materials with each item&apos;s routing operations —
          read straight from SYSPRO structures and routings.
        </p>
      </div>

      <div className="bom-search">
        <input
          type="text"
          placeholder="Search stock code or description…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          aria-label="Stock code search"
        />
        <button className="btn btn-sm" onClick={search} disabled={searching}>
          <Search size={13} /> {searching ? '…' : 'Search'}
        </button>
        {tree && (
          <div className="bom-tree-tools">
            <button className="btn btn-sm btn-ghost" onClick={() => setCollapsed(new Set())} title="Expand all">
              <ListTree size={13} /> Expand
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setCollapsed(new Set(allKeys.slice(1)))}
              title="Collapse all (keep root)"
            >
              <ListCollapse size={13} /> Collapse
            </button>
          </div>
        )}
      </div>

      {notice && <div className="bom-notice" role="alert">ⓘ {notice}</div>}

      {hits.length > 0 && (
        <div className="bom-hits">
          {hits.map((h) => (
            <button key={h.stockCode} className="bom-hit" onClick={() => load(h.stockCode)} disabled={loading}>
              <span className="mono">{h.stockCode}</span>
              <span className="bom-hit-desc">{h.description}</span>
              {!h.hasRouting && <span className="bom-chip bought">no routing</span>}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="bom-empty">Loading structure…</div>}

      {!tree && !loading && hits.length === 0 && (
        <div className="bom-empty">
          <Layers size={26} aria-hidden="true" />
          <p>Search a stock code to explore its structure and routings.</p>
        </div>
      )}

      {tree && !loading && (
        <>
          <div className="bom-tree">{renderNode(tree.root, '')}</div>
          {tree.warnings.length > 0 && (
            <div className="bom-warnings">
              {tree.warnings.map((w, i) => (<div key={i}>ⓘ {w}</div>))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default BomTreeView;
