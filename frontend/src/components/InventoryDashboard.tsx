/**
 * InventoryDashboard
 * Displays Stock On Hand and Open Purchase Orders pulled live from Syspro.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { inventoryService, StockItem, PurchaseOrderLine, MaterialShortage, apiErrorMessage } from '../services/api';
import './InventoryDashboard.css';
import { AlertTriangle, Package, ShoppingCart } from 'lucide-react';

// ─────────────────────────────────────────────────────────────
// Sub-component: Stock On Hand table
// ─────────────────────────────────────────────────────────────
interface StockPanelProps {
  isDarkMode: boolean;
}

const StockPanel: React.FC<StockPanelProps> = ({ isDarkMode }) => {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [warehouses, setWarehouses] = useState<{ Warehouse: string; Description: string }[]>([]);
  const [sortKey, setSortKey] = useState<keyof StockItem>('StockCode');
  const [sortAsc, setSortAsc] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await inventoryService.getStock({
        stockCode: search || undefined,
        warehouse: warehouseFilter || undefined,
        lowStock: lowStockOnly || undefined
      });
      setItems(result.items);
    } catch (e) {
      setError(apiErrorMessage(e, 'Request failed'));
    } finally {
      setLoading(false);
    }
  }, [search, warehouseFilter, lowStockOnly]);

  useEffect(() => {
    inventoryService.getWarehouses()
      .then(r => setWarehouses(r.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [load]);

  const handleSort = (key: keyof StockItem) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = [...items].sort((a, b) => {
    const av = a[sortKey]; const bv = b[sortKey];
    if (av == null) return 1; if (bv == null) return -1;
    const cmp = typeof av === 'number' ? (av as number) - (bv as number) : String(av).localeCompare(String(bv));
    return sortAsc ? cmp : -cmp;
  });

  // 7,900 stock rows rendered at once froze the tab. Show 300 at a time;
  // search/filters narrow the list, "Show more" extends it.
  const [rowLimit, setRowLimit] = React.useState(300);
  React.useEffect(() => { setRowLimit(300); }, [search, warehouseFilter, lowStockOnly]);
  const shown = sorted.slice(0, rowLimit);

  const SortArrow = ({ col }: { col: keyof StockItem }) =>
    sortKey === col ? <span className="sort-arrow">{sortAsc ? ' ↑' : ' ↓'}</span> : null;

  const stockStatus = (item: StockItem) => {
    if (item.FreeOnHand <= 0) return 'stock-zero';
    if (item.SafetyStockQty > 0 && item.QtyOnHand <= item.SafetyStockQty) return 'stock-low';
    return 'stock-ok';
  };

  return (
    <div className={`inv-panel ${isDarkMode ? 'dark' : ''}`}>
      <div className="inv-panel-header">
        <h3>Stock On Hand</h3>
        <span className="inv-count">{items.length} items</span>
        <button className="inv-refresh-btn" onClick={load} disabled={loading} title="Refresh">
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className="inv-filters">
        <input
          className="inv-search"
          type="text"
          placeholder="Search stock code / description…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="inv-select"
          value={warehouseFilter}
          onChange={e => setWarehouseFilter(e.target.value)}
        >
          <option value="">All Warehouses</option>
          {warehouses.map(w => (
            <option key={w.Warehouse} value={w.Warehouse}>{w.Warehouse} – {w.Description}</option>
          ))}
        </select>
        <label className="inv-checkbox">
          <input type="checkbox" checked={lowStockOnly} onChange={e => setLowStockOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      {error && <div className="inv-error"><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> {error}</div>}

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('StockCode')}>Stock Code<SortArrow col="StockCode" /></th>
              <th onClick={() => handleSort('Description')}>Description<SortArrow col="Description" /></th>
              <th onClick={() => handleSort('Warehouse')}>WH<SortArrow col="Warehouse" /></th>
              <th onClick={() => handleSort('QtyOnHand')} className="num">On Hand<SortArrow col="QtyOnHand" /></th>
              <th onClick={() => handleSort('QtyAllocated')} className="num">Allocated<SortArrow col="QtyAllocated" /></th>
              <th onClick={() => handleSort('QtyAllocatedWip')} className="num">WIP Alloc<SortArrow col="QtyAllocatedWip" /></th>
              <th onClick={() => handleSort('FreeOnHand')} className="num">Free<SortArrow col="FreeOnHand" /></th>
              <th onClick={() => handleSort('QtyOnOrder')} className="num">On Order<SortArrow col="QtyOnOrder" /></th>
              <th onClick={() => handleSort('SafetyStockQty')} className="num">Safety<SortArrow col="SafetyStockQty" /></th>
              <th onClick={() => handleSort('UnitCost')} className="num">Unit Cost<SortArrow col="UnitCost" /></th>
              <th onClick={() => handleSort('DateLastSale')}>Last Sale<SortArrow col="DateLastSale" /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && !loading && (
              <tr><td colSpan={11} className="inv-empty">No items found</td></tr>
            )}
            {shown.map((item, i) => (
              <tr key={`${item.StockCode}-${item.Warehouse}-${i}`} className={stockStatus(item)}>
                <td className="code">{item.StockCode}</td>
                <td>{item.Description}</td>
                <td className="center">{item.Warehouse}</td>
                <td className="num">{fmt(item.QtyOnHand)}</td>
                <td className="num">{fmt(item.QtyAllocated)}</td>
                <td className="num">{fmt(item.QtyAllocatedWip)}</td>
                <td className={`num ${item.FreeOnHand <= 0 ? 'zero' : ''}`}>{fmt(item.FreeOnHand)}</td>
                <td className="num">{fmt(item.QtyOnOrder)}</td>
                <td className="num">{fmt(item.SafetyStockQty)}</td>
                <td className="num">{fmtCurrency(item.UnitCost)}</td>
                <td className="date">{fmtDate(item.DateLastSale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > shown.length && (
        <div className="inv-more">
          Showing {shown.length} of {sorted.length} — search or filter to narrow, or{' '}
          <button className="inv-refresh-btn" onClick={() => setRowLimit((n) => n + 1000)}>show 1,000 more</button>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Sub-component: Open Purchase Orders table
// ─────────────────────────────────────────────────────────────
interface POPanelProps {
  isDarkMode: boolean;
}

const POPanel: React.FC<POPanelProps> = ({ isDarkMode }) => {
  const [items, setItems] = useState<PurchaseOrderLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [sortKey, setSortKey] = useState<keyof PurchaseOrderLine>('LineDueDate');
  const [sortAsc, setSortAsc] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await inventoryService.getPurchaseOrders({
        stockCode: search || undefined,
        supplier: supplierFilter || undefined
      });
      setItems(result.items);
    } catch (e) {
      setError(apiErrorMessage(e, 'Request failed'));
    } finally {
      setLoading(false);
    }
  }, [search, supplierFilter]);

  useEffect(() => {
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [load]);

  const handleSort = (key: keyof PurchaseOrderLine) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = [...items].sort((a, b) => {
    const av = a[sortKey]; const bv = b[sortKey];
    if (av == null) return 1; if (bv == null) return -1;
    const cmp = typeof av === 'number' ? (av as number) - (bv as number) : String(av).localeCompare(String(bv));
    return sortAsc ? cmp : -cmp;
  });

  const SortArrow = ({ col }: { col: keyof PurchaseOrderLine }) =>
    sortKey === col ? <span className="sort-arrow">{sortAsc ? ' ↑' : ' ↓'}</span> : null;

  const overdueClass = (line: PurchaseOrderLine) => {
    if (!line.LineDueDate) return '';
    return new Date(line.LineDueDate) < new Date() ? 'overdue' : '';
  };

  const totalOutstanding = items.reduce((s, i) => s + (Number(i.OutstandingQty) || 0), 0);
  const totalValue = items.reduce((s, i) => s + (Number(i.OutstandingValue) || 0), 0);

  // Group by PO for collapsible view
  const grouped = sorted.reduce<Map<string, PurchaseOrderLine[]>>((m, line) => {
    const arr = m.get(line.PurchaseOrder) || [];
    arr.push(line);
    m.set(line.PurchaseOrder, arr);
    return m;
  }, new Map());

  const togglePO = (po: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(po)) next.delete(po); else next.add(po);
      return next;
    });
  };

  return (
    <div className={`inv-panel ${isDarkMode ? 'dark' : ''}`}>
      <div className="inv-panel-header">
        <h3>Open Purchase Orders</h3>
        <span className="inv-count">{grouped.size} POs · {items.length} lines</span>
        <button className="inv-refresh-btn" onClick={load} disabled={loading} title="Refresh">
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className="inv-summary-bar">
        <span>Total Outstanding Qty: <strong>{fmt(totalOutstanding)}</strong></span>
        <span>Total Value: <strong>{fmtCurrency(totalValue)}</strong></span>
      </div>

      <div className="inv-filters">
        <input
          className="inv-search"
          type="text"
          placeholder="Search stock code…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <input
          className="inv-search"
          type="text"
          placeholder="Supplier…"
          value={supplierFilter}
          onChange={e => setSupplierFilter(e.target.value)}
        />
      </div>

      {error && <div className="inv-error"><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> {error}</div>}

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <th onClick={() => handleSort('PurchaseOrder')}>PO Number<SortArrow col="PurchaseOrder" /></th>
              <th onClick={() => handleSort('OrderStatusLabel')}>Status<SortArrow col="OrderStatusLabel" /></th>
              <th onClick={() => handleSort('Supplier')}>Supplier<SortArrow col="Supplier" /></th>
              <th onClick={() => handleSort('StockCode')}>Stock Code<SortArrow col="StockCode" /></th>
              <th>{/* description */}</th>
              <th onClick={() => handleSort('OrderedQty')} className="num">Ordered<SortArrow col="OrderedQty" /></th>
              <th onClick={() => handleSort('ReceivedQty')} className="num">Received<SortArrow col="ReceivedQty" /></th>
              <th onClick={() => handleSort('OutstandingQty')} className="num">Outstanding<SortArrow col="OutstandingQty" /></th>
              <th onClick={() => handleSort('LineDueDate')}>Due Date<SortArrow col="LineDueDate" /></th>
              <th onClick={() => handleSort('UnitPrice')} className="num">Unit Price<SortArrow col="UnitPrice" /></th>
              <th onClick={() => handleSort('OutstandingValue')} className="num">Value<SortArrow col="OutstandingValue" /></th>
            </tr>
          </thead>
          <tbody>
            {grouped.size === 0 && !loading && (
              <tr><td colSpan={12} className="inv-empty">No open purchase orders</td></tr>
            )}
            {Array.from(grouped.entries()).map(([po, lines]) => {
              const isOpen = expanded.has(po);
              const hdr = lines[0];
              const totalLines = lines.reduce((s, l) => s + Number(l.OutstandingQty || 0), 0);
              return (
                <React.Fragment key={po}>
                  <tr className={`po-header-row ${overdueClass(hdr)}`} onClick={() => togglePO(po)}>
                    <td className="toggle">{isOpen ? '▾' : '▸'}</td>
                    <td className="code">{hdr.PurchaseOrder}</td>
                    <td><span className={`status-badge status-${hdr.OrderStatus}`}>{hdr.OrderStatusLabel}</span></td>
                    <td>{hdr.Supplier}</td>
                    <td colSpan={2} className="muted">{lines.length} line{lines.length !== 1 ? 's' : ''}</td>
                    <td className="num" colSpan={2}></td>
                    <td className="num"><strong>{fmt(totalLines)}</strong></td>
                    <td className="date">{fmtDate(hdr.OrderDueDate)}</td>
                    <td></td>
                    <td className="num">{fmtCurrency(lines.reduce((s, l) => s + Number(l.OutstandingValue || 0), 0))}</td>
                  </tr>
                  {isOpen && lines.map((line, li) => (
                    <tr key={`${po}-${line.Line}-${li}`} className={`po-line-row ${overdueClass(line)}`}>
                      <td></td>
                      <td className="muted">Line {line.Line}</td>
                      <td></td>
                      <td></td>
                      <td className="code">{line.StockCode}</td>
                      <td className="muted small">{line.StockDescription}</td>
                      <td className="num">{fmt(line.OrderedQty)}</td>
                      <td className="num">{fmt(line.ReceivedQty)}</td>
                      <td className="num">{fmt(line.OutstandingQty)}</td>
                      <td className={`date ${overdueClass(line)}`}>{fmtDate(line.LineDueDate)}</td>
                      <td className="num">{fmtCurrency(line.UnitPrice)}</td>
                      <td className="num">{fmtCurrency(line.OutstandingValue)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Sub-component: Material Shortages panel
// ─────────────────────────────────────────────────────────────
interface ShortagesPanelProps {
  isDarkMode: boolean;
}

const ShortagesPanel: React.FC<ShortagesPanelProps> = ({ isDarkMode }) => {
  const [data, setData] = useState<{ items: MaterialShortage[]; count: number; affectedJobs: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await inventoryService.getShortages();
      setData(result);
    } catch (e) {
      setError(apiErrorMessage(e, 'Request failed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const items = data?.items || [];

  return (
    <div className={`inv-panel ${isDarkMode ? 'dark' : ''}`}>
      <div className="inv-panel-header">
        <h3>Material Shortages</h3>
        {data && (
          <span className="inv-count badge-danger">
            {data.count} shortages · {data.affectedJobs} jobs affected
          </span>
        )}
        <button className="inv-refresh-btn" onClick={load} disabled={loading} title="Refresh">
          {loading ? '…' : '↻'}
        </button>
      </div>

      {error && <div className="inv-error"><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> {error}</div>}
      {!error && items.length === 0 && !loading && (
        <div className="inv-empty-state">✓ No material shortages detected across open WIP jobs</div>
      )}

      {items.length > 0 && (
        <div className="inv-table-wrap">
          <table className="inv-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Parent Item</th>
                <th>Component</th>
                <th>Description</th>
                <th>Supplier</th>
                <th className="num">Lead Time</th>
                <th className="num">Total Reqd</th>
                <th className="num">Issued</th>
                <th className="num">Outstanding</th>
                <th className="num">Free On Hand</th>
                <th className="num">Open PO</th>
                <th className="num">Net Available</th>
                <th className="num shortage-col">Shortage</th>
                <th>UOM</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => (
                <tr key={i} className="shortage-row">
                  <td className="code">{s.job}</td>
                  <td className="code">{s.jobStockCode}</td>
                  <td className="code">{s.componentCode}</td>
                  <td>{s.componentDesc}</td>
                  <td className="muted">{s.preferredSupplier || '—'}</td>
                  <td className="num">{s.leadTime ? `${s.leadTime}d` : '—'}</td>
                  <td className="num">{fmt(s.totalRequired)}</td>
                  <td className="num">{fmt(s.qtyIssued)}</td>
                  <td className="num">{fmt(s.qtyOutstanding)}</td>
                  <td className="num">{fmt(s.freeOnHand)}</td>
                  <td className="num">{fmt(s.openPoQty)}</td>
                  <td className="num">{fmt(s.netAvailable)}</td>
                  <td className="num shortage-val">{fmt(s.shortage)}</td>
                  <td>{s.unitOfMeasure}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Main InventoryDashboard
// ─────────────────────────────────────────────────────────────
type Tab = 'stock' | 'po' | 'shortages';

interface InventoryDashboardProps {
  isDarkMode?: boolean;
}

const InventoryDashboard: React.FC<InventoryDashboardProps> = ({ isDarkMode = false }) => {
  const [tab, setTab] = useState<Tab>('stock');

  return (
    <div className={`inv-dashboard ${isDarkMode ? 'dark' : ''}`}>
      <div className="inv-tab-bar">
        <button
          className={`inv-tab ${tab === 'stock' ? 'active' : ''}`}
          onClick={() => setTab('stock')}
        >
          <Package size={13} className="ui-icon" aria-hidden="true" /> Stock On Hand
        </button>
        <button
          className={`inv-tab ${tab === 'po' ? 'active' : ''}`}
          onClick={() => setTab('po')}
        >
          <ShoppingCart size={13} className="ui-icon" aria-hidden="true" /> Open Purchase Orders
        </button>
        <button
          className={`inv-tab ${tab === 'shortages' ? 'active' : ''}`}
          onClick={() => setTab('shortages')}
        >
          <AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> Material Shortages
        </button>
      </div>

      <div className="inv-tab-content">
        {tab === 'stock' && <StockPanel isDarkMode={isDarkMode} />}
        {tab === 'po' && <POPanel isDarkMode={isDarkMode} />}
        {tab === 'shortages' && <ShortagesPanel isDarkMode={isDarkMode} />}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtCurrency(n: number | null | undefined): string {
  if (n == null || n === 0) return '—';
  return Number(n).toLocaleString(undefined, { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return d;
  }
}

export default InventoryDashboard;
