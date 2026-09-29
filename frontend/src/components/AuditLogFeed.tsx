/**
 * AuditLogFeed — renders recent sch_AuditLog entries as a timeline feed.
 * Shows: timestamp, actor, action, entityType / entityId, and optional traceId.
 * Refreshes on mount; provides a manual Refresh button.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { auditService, AuditRow, apiErrorMessage } from '../services/api';
import './AuditLogFeed.css';

const AUDIT_LIMIT = 100;

/** Human-readable labels for common action codes. */
const ACTION_LABELS: Record<string, string> = {
  GENERATE:          'Schedule generated',
  APPROVE_OVERRIDE:  'Constraint override approved',
  RESTORE_VERSION:   'Version restored',
  SAVE:              'Schedule saved',
  LOCK_OP:           'Operation locked',
  UNLOCK_OP:         'Operation unlocked',
  NUDGE_OP:          'Operation nudged',
  DRAG_OP:           'Operation moved',
};

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function entityLabel(row: AuditRow): string {
  if (!row.entityType && !row.entityId) return '';
  return `${row.entityType}:${row.entityId}`;
}

const AuditLogFeed: React.FC = () => {
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await auditService.getHistory({ limit: AUDIT_LIMIT });
      setEntries(result.entries);
    } catch (err: any) {
      setError(apiErrorMessage(err, 'Failed to load audit log'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && entries.length === 0) {
    return <div className="alf-loading">Loading audit log…</div>;
  }

  if (error && entries.length === 0) {
    return (
      <div className="alf-error">
        <span>{error}</span>
        <button className="alf-refresh-btn" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="alf-root">
      <div className="alf-header">
        <span className="alf-title">Audit Log</span>
        <span className="alf-count">{entries.length} entries</span>
        <button className="alf-refresh-btn" onClick={load} disabled={loading} aria-label="Refresh audit log">
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="alf-empty">No audit log entries found.</div>
      ) : (
        <ul className="alf-list" role="list">
          {entries.map((row) => {
            const isExpanded = expandedId === row.auditId;
            const hasDiff = !!(row.before || row.after || row.traceId);
            return (
              <li
                key={row.auditId}
                className={`alf-item${isExpanded ? ' alf-item--expanded' : ''}`}
              >
                <div
                  className="alf-item-summary"
                  onClick={() => hasDiff && setExpandedId(isExpanded ? null : row.auditId)}
                  role={hasDiff ? 'button' : undefined}
                  tabIndex={hasDiff ? 0 : undefined}
                  onKeyDown={hasDiff ? (e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedId(isExpanded ? null : row.auditId); } : undefined}
                  aria-expanded={hasDiff ? isExpanded : undefined}
                >
                  <span className="alf-ts">{formatTs(row.ts)}</span>
                  <span className="alf-actor">{row.actorId}</span>
                  <span className="alf-action">{actionLabel(row.action)}</span>
                  {entityLabel(row) && (
                    <span className="alf-entity">{entityLabel(row)}</span>
                  )}
                  {hasDiff && (
                    <span className="alf-chevron" aria-hidden="true">{isExpanded ? '▲' : '▼'}</span>
                  )}
                </div>

                {isExpanded && hasDiff && (
                  <div className="alf-detail">
                    {row.traceId && (
                      <div className="alf-detail-row">
                        <span className="alf-detail-key">Trace ID</span>
                        <code className="alf-detail-val">{row.traceId}</code>
                      </div>
                    )}
                    {row.before && (
                      <div className="alf-detail-row">
                        <span className="alf-detail-key">Before</span>
                        <pre className="alf-detail-pre">{tryPrettyJson(row.before)}</pre>
                      </div>
                    )}
                    {row.after && (
                      <div className="alf-detail-row">
                        <span className="alf-detail-key">After</span>
                        <pre className="alf-detail-pre">{tryPrettyJson(row.after)}</pre>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

function tryPrettyJson(val: string): string {
  try { return JSON.stringify(JSON.parse(val), null, 2); }
  catch { return val; }
}

export default AuditLogFeed;
