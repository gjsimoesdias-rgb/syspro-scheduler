import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { jobService, BomDetail, BomDetailLine, BomLineStatus, apiErrorMessage } from '../services/api';
import './BomDetailModal.css';

interface BomDetailModalProps {
  jobId: string | null;
  /** When true the modal renders. Toggle from the parent. */
  open: boolean;
  onClose: () => void;
}

const STATUS_LABEL: Record<BomLineStatus, string> = {
  Materials: 'Available',
  Partial: 'Partial',
  'No Materials': 'Short',
};

const fmtNumber = (value: number | undefined | null, fractionDigits = 2): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return value.toExponential(2);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
};

/**
 * Modal showing a single job's BOM and per-line material availability.
 *
 * Triggered from the right-click context menu on a Gantt operation bar.
 * Fetches data on open via `jobService.getBomDetail(jobId)`.
 */
export const BomDetailModal: React.FC<BomDetailModalProps> = ({ jobId, open, onClose }) => {
  const [data, setData] = useState<BomDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'short'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (code: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  useEffect(() => {
    if (!open || !jobId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    jobService
      .getBomDetail(jobId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          apiErrorMessage(err, 'Failed to load BOM detail');
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, jobId]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filteredLines = useMemo(() => {
    if (!data) return [];
    if (filter === 'short') return data.lines.filter((l) => l.status !== 'Materials');
    return data.lines;
  }, [data, filter]);

  if (!open) return null;

  return (
    <div
      className="bom-modal__overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Material availability for job"
      onClick={onClose}
    >
      <div className="bom-modal" onClick={(e) => e.stopPropagation()}>
        <header className="bom-modal__header">
          <div>
            <h2 className="bom-modal__title">Materials availability</h2>
            <div className="bom-modal__subtitle">
              {jobId ? (
                <>
                  Job <strong>{jobId}</strong>
                  {data?.itemCode ? (
                    <>
                      {' '}
                      · Item <strong>{data.itemCode}</strong>
                    </>
                  ) : null}
                  {data?.quantity ? (
                    <>
                      {' '}
                      · Qty <strong>{fmtNumber(data.quantity, 0)}</strong>
                    </>
                  ) : null}
                </>
              ) : (
                'No job selected'
              )}
            </div>
          </div>
          <button
            type="button"
            className="bom-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        {loading && <div className="bom-modal__state">Loading materials…</div>}

        {error && (
          <div className="bom-modal__state bom-modal__state--error">
            <strong>Couldn&apos;t load BOM</strong>
            <div>{error}</div>
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div className="bom-modal__summary">
              <StatusPill status={data.status} large />
              <SummaryStat label="BOM lines" value={fmtNumber(data.lineCount, 0)} />
              <SummaryStat
                label="Available"
                value={fmtNumber(data.okCount ?? 0, 0)}
                tone="ok"
              />
              <SummaryStat
                label="Partial"
                value={fmtNumber(data.partialCount ?? 0, 0)}
                tone="warn"
              />
              <SummaryStat
                label="Short"
                value={fmtNumber(data.shortageCount, 0)}
                tone={data.shortageCount > 0 ? 'bad' : 'muted'}
              />
              <div className="bom-modal__filter" role="group" aria-label="Filter">
                <button
                  type="button"
                  className={filter === 'all' ? 'is-active' : ''}
                  onClick={() => setFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={filter === 'short' ? 'is-active' : ''}
                  onClick={() => setFilter('short')}
                >
                  Issues only
                </button>
              </div>
            </div>

            {data.note && <div className="bom-modal__note">{data.note}</div>}

            {data.lines.length === 0 ? (
              <div className="bom-modal__state">No BOM lines for this job.</div>
            ) : (
              <div className="bom-modal__table-wrap">
                <table className="bom-modal__table">
                  <thead>
                    <tr>
                      <th aria-label="expand" />
                      <th>Component</th>
                      <th>Description</th>
                      <th className="num">Required</th>
                      <th className="num" title="Sum of QtyOnHand across all warehouses">
                        On hand
                      </th>
                      <th
                        className="num"
                        title="QtyAllocWip + QtyAllocSO + outstanding requirements held by OTHER open jobs"
                      >
                        Reserved
                      </th>
                      <th className="num" title="Sum of outstanding open PO quantity">
                        Incoming
                      </th>
                      <th className="num">Available</th>
                      <th className="num">Shortage</th>
                      <th>UoM</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLines.map((line) => {
                      const rowClass =
                        line.status === 'No Materials'
                          ? 'bom-row--bad'
                          : line.status === 'Partial'
                          ? 'bom-row--warn'
                          : '';
                      const isOpen = expanded.has(line.componentCode);
                      const hasDetail =
                        (line.warehouses && line.warehouses.length > 0) ||
                        (line.incomingReceipts && line.incomingReceipts.length > 0) ||
                        (line.otherJobsHoldQty || 0) > 0;
                      return (
                        <React.Fragment key={line.componentCode}>
                          <tr className={rowClass}>
                            <td className="bom-modal__caret">
                              {hasDetail ? (
                                <button
                                  type="button"
                                  className={`bom-modal__expand-btn${
                                    isOpen ? ' is-open' : ''
                                  }`}
                                  onClick={() => toggleExpand(line.componentCode)}
                                  aria-expanded={isOpen}
                                  aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                                  title={isOpen ? 'Hide breakdown' : 'Show warehouse + PO breakdown'}
                                >
                                  ▸
                                </button>
                              ) : null}
                            </td>
                            <td>
                              <code>{line.componentCode}</code>
                            </td>
                            <td className="bom-modal__desc">
                              {line.description || (
                                <span className="bom-modal__muted">—</span>
                              )}
                            </td>
                            <td className="num">{fmtNumber(line.requiredQty)}</td>
                            <td className="num">{fmtNumber(line.stockOnHand)}</td>
                            <td
                              className="num"
                              title={[
                                line.wipAllocQty != null
                                  ? `WIP allocations: ${fmtNumber(line.wipAllocQty)}`
                                  : null,
                                line.soAllocQty != null
                                  ? `Sales-order allocations: ${fmtNumber(line.soAllocQty)}`
                                  : null,
                                line.otherJobsHoldQty != null
                                  ? `Held by other open jobs: ${fmtNumber(
                                      line.otherJobsHoldQty
                                    )}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join('\n')}
                            >
                              {fmtNumber(line.reservedQty)}
                            </td>
                            <td className="num">{fmtNumber(line.openPoQty)}</td>
                            <td className="num">{fmtNumber(line.availableQty)}</td>
                            <td
                              className={`num ${
                                line.shortageQty > 0 ? 'bom-modal__shortage' : ''
                              }`}
                            >
                              {line.shortageQty > 0 ? fmtNumber(line.shortageQty) : '—'}
                            </td>
                            <td>{line.unitOfMeasure || '—'}</td>
                            <td>
                              <StatusPill status={line.status} />
                            </td>
                          </tr>
                          {isOpen && hasDetail && (
                            <tr className="bom-modal__detail-row">
                              <td />
                              <td colSpan={10}>
                                <BomLineDetail line={line} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <footer className="bom-modal__footer">
          <span className="bom-modal__muted">
            Reserved = WIP allocations + SO allocations + holds for other open jobs.
            Available = max(0, on hand − reserved) + incoming PO. Click ▸ to drill
            into warehouses and PO receipts.
          </span>
          <button type="button" className="bom-modal__ok" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
};

const StatusPill: React.FC<{ status: BomLineStatus; large?: boolean }> = ({ status, large }) => {
  const tone =
    status === 'Materials' ? 'ok' : status === 'Partial' ? 'warn' : 'bad';
  return (
    <span className={`bom-pill bom-pill--${tone}${large ? ' bom-pill--lg' : ''}`}>
      {STATUS_LABEL[status]}
    </span>
  );
};

/**
 * Drill-down content for a BOM line: per-warehouse stock breakdown plus
 * a list of incoming PO receipts. Either side renders independently, so
 * a component with stock but no PO (or vice versa) still shows useful info.
 */
const BomLineDetail: React.FC<{ line: BomDetailLine }> = ({ line }) => {
  const warehouses = line.warehouses || [];
  const receipts = line.incomingReceipts || [];

  const todayMs = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  return (
    <div className="bom-detail">
      <div className="bom-detail__col">
        <div className="bom-detail__heading">Warehouses</div>
        {warehouses.length === 0 ? (
          <div className="bom-modal__muted">No warehouse rows for this component.</div>
        ) : (
          <table className="bom-detail__table">
            <thead>
              <tr>
                <th>Warehouse</th>
                <th className="num">On hand</th>
                <th className="num" title="QtyAllocWip — held by open jobs">
                  WIP alloc
                </th>
                <th className="num" title="QtyAllocSO — held by sales orders">
                  SO alloc
                </th>
                <th className="num">Free</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map((w) => {
                const free = Math.max(0, w.qtyOnHand - w.qtyAllocWip - w.qtyAllocSO);
                return (
                  <tr key={w.warehouseCode}>
                    <td>
                      <code>{w.warehouseCode}</code>
                    </td>
                    <td className="num">{fmtNumber(w.qtyOnHand)}</td>
                    <td className="num">{fmtNumber(w.qtyAllocWip)}</td>
                    <td className="num">{fmtNumber(w.qtyAllocSO)}</td>
                    <td className="num">{fmtNumber(free)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {(line.otherJobsHoldQty || 0) > 0 && (
          <div className="bom-detail__hold">
            <span className="bom-pill bom-pill--warn">
              Held by other open jobs: {fmtNumber(line.otherJobsHoldQty)}{' '}
              {line.unitOfMeasure || ''}
            </span>
          </div>
        )}
      </div>

      <div className="bom-detail__col">
        <div className="bom-detail__heading">Incoming POs</div>
        {receipts.length === 0 ? (
          <div className="bom-modal__muted">No outstanding purchase orders.</div>
        ) : (
          <table className="bom-detail__table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Promise</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r, idx) => {
                const promise = r.promiseDate ? new Date(r.promiseDate) : null;
                const isLate = promise && promise.getTime() < todayMs;
                return (
                  <tr key={`${r.poNumber}-${idx}`} className={isLate ? 'bom-detail__late' : ''}>
                    <td>
                      <code>{r.poNumber || '—'}</code>
                    </td>
                    <td title={r.dueDate ? `Due: ${fmtDate(r.dueDate)}` : undefined}>
                      {fmtDate(r.promiseDate)}
                      {isLate && <span className="bom-detail__late-tag">overdue</span>}
                    </td>
                    <td className="num">{fmtNumber(r.outstandingQty)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const SummaryStat: React.FC<{
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
}> = ({ label, value, tone }) => (
  <div className={`bom-stat${tone ? ` bom-stat--${tone}` : ''}`}>
    <div className="bom-stat__value">{value}</div>
    <div className="bom-stat__label">{label}</div>
  </div>
);

export default BomDetailModal;
