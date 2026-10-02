import React, { useCallback, useMemo, useState } from 'react';
import { ConstraintViolation, Job } from '../types';
import './ConstraintViolations.css';

interface ConstraintViolationsProps {
  violations: ConstraintViolation[];
  selectedViolationId?: string;
  onSelect?: (violation: ConstraintViolation) => void;
  /**
   * Currently-loaded jobs. When supplied, each violation's affectedOperationId
   * is resolved to its work centre so violations can be grouped by the resource
   * that ran out of room (e.g. which machine caused the CapacityExceeded).
   */
  jobs?: Job[];
}

const SEVERITY_RANK: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
const NO_WC = 'Not machine-specific';

const ConstraintViolations: React.FC<ConstraintViolationsProps> = ({ violations, selectedViolationId, onSelect, jobs }) => {
  // S3.2: expandable info list
  const [showAllInfo, setShowAllInfo] = useState(false);
  const [groupMode, setGroupMode] = useState<'severity' | 'workcentre'>('severity');

  // opId -> work-centre name, built from the loaded jobs' operations.
  const opWorkcentre = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs || []) {
      for (const op of j.operations || []) {
        m.set(op.opId, op.workcentreName || op.workcentreId);
      }
    }
    return m;
  }, [jobs]);

  const workcentreOf = useCallback((v: ConstraintViolation): string =>
    (v.affectedOperationId ? opWorkcentre.get(v.affectedOperationId) : undefined) || NO_WC, [opWorkcentre]);

  // Violations grouped by work centre, largest group first, then critical→info.
  const workcentreGroups = useMemo(() => {
    const g = new Map<string, ConstraintViolation[]>();
    for (const v of violations) {
      const key = workcentreOf(v);
      const arr = g.get(key);
      if (arr) arr.push(v);
      else g.set(key, [v]);
    }
    for (const arr of g.values()) {
      arr.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    }
    return [...g.entries()].sort((a, b) => {
      // Real work centres before the "not machine-specific" bucket, then by size.
      if ((a[0] === NO_WC) !== (b[0] === NO_WC)) return a[0] === NO_WC ? 1 : -1;
      return b[1].length - a[1].length;
    });
  }, [violations, workcentreOf]);

  const hasWcInfo = useMemo(
    () => violations.some((v) => v.affectedOperationId && opWorkcentre.has(v.affectedOperationId)),
    [violations, opWorkcentre]
  );

  if (!violations || violations.length === 0) {
    return (
      <div className="constraint-violations">
        <h3>Constraint Status</h3>
        <div className="no-violations"><span className="cv-checkmark">&#10003;</span> All constraints satisfied</div>
      </div>
    );
  }

  const criticalViolations = violations.filter((v) => v.severity === 'Critical');
  const warningViolations = violations.filter((v) => v.severity === 'Warning');
  const infoViolations = violations.filter((v) => v.severity === 'Info');

  const renderItem = (violation: ConstraintViolation, opts?: { showSeverity?: boolean; showWc?: boolean }) => (
    <div
      key={violation.violationId}
      className={`violation-item${onSelect ? ' violation-item--clickable' : ''}${selectedViolationId === violation.violationId ? ' violation-item--selected' : ''}`}
      onClick={() => onSelect?.(violation)}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => e.key === 'Enter' && onSelect?.(violation)}
    >
      <div className="violation-content">
        <div className="violation-type">
          {opts?.showSeverity && (
            <span
              className={`cv-dot cv-dot--${String(violation.severity).toLowerCase()}`}
              aria-hidden="true"
              style={{ marginRight: 6 }}
            />
          )}
          {violation.type}
          {opts?.showWc && workcentreOf(violation) !== NO_WC && (
            <span className="affected-id" style={{ marginLeft: 6 }}>{workcentreOf(violation)}</span>
          )}
        </div>
        <div className="violation-description">{violation.description}</div>
        {violation.suggestedAction && violation.severity === 'Critical' && (
          <div className="suggested-action">
            <span className="cv-arrow" aria-hidden="true">&#8594;</span> {violation.suggestedAction}
          </div>
        )}
      </div>
      {violation.affectedJobId && (
        <div className="affected-id">{violation.affectedJobId}</div>
      )}
    </div>
  );

  return (
    <div className="constraint-violations">
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Constraint Violations</h3>
        {hasWcInfo && (
          <div className="cv-groupmode-toggle" role="group" aria-label="Group violations by" style={{ display: 'flex', gap: 4 }}>
            <button
              className={`btn btn-sm${groupMode === 'severity' ? ' active-tab-btn' : ''}`}
              onClick={() => setGroupMode('severity')}
              title="Group by severity"
            >
              By severity
            </button>
            <button
              className={`btn btn-sm${groupMode === 'workcentre' ? ' active-tab-btn' : ''}`}
              onClick={() => setGroupMode('workcentre')}
              title="Group by the work centre that ran out of room"
            >
              By work centre
            </button>
          </div>
        )}
      </div>

      {groupMode === 'workcentre' ? (
        <>
          {workcentreGroups.map(([wc, items]) => (
            <div className="violation-section" key={wc}>
              <div className="section-header">
                <span className="section-title">
                  <span className="cv-dot cv-dot--warning" aria-hidden="true"></span>{' '}
                  {wc} ({items.length})
                </span>
              </div>
              <div className="violations-list">
                {items.map((v) => renderItem(v, { showSeverity: true }))}
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          {criticalViolations.length > 0 && (
            <div className="violation-section critical">
              <div className="section-header">
                <span className="section-title"><span className="cv-dot cv-dot--critical" aria-hidden="true"></span> Critical ({criticalViolations.length})</span>
              </div>
              <div className="violations-list">
                {criticalViolations.map((v) => renderItem(v))}
              </div>
            </div>
          )}

          {warningViolations.length > 0 && (
            <div className="violation-section warning">
              <div className="section-header">
                <span className="section-title"><span className="cv-dot cv-dot--warning" aria-hidden="true"></span> Warnings ({warningViolations.length})</span>
              </div>
              <div className="violations-list">
                {warningViolations.map((v) => renderItem(v))}
              </div>
            </div>
          )}

          {infoViolations.length > 0 && (
            <div className="violation-section info">
              <div className="section-header">
                <span className="section-title"><span className="cv-dot cv-dot--info" aria-hidden="true"></span> Info ({infoViolations.length})</span>
              </div>
              <div className="violations-list">
                {infoViolations.slice(0, showAllInfo ? undefined : 3).map((v) => renderItem(v))}
                {infoViolations.length > 3 && (
                  <button
                    className="violation-more violation-more--btn"
                    onClick={() => setShowAllInfo((p) => !p)}
                  >
                    {showAllInfo ? 'Show fewer' : `+${infoViolations.length - 3} more info items`}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="summary-stats">
        <div className="stat">
          <label>Total Violations:</label>
          <span>{violations.length}</span>
        </div>
        <div className="stat critical-stat">
          <label>Critical:</label>
          <span>{criticalViolations.length}</span>
        </div>
        <div className="stat warning-stat">
          <label>Warning:</label>
          <span>{warningViolations.length}</span>
        </div>
      </div>
    </div>
  );
};

export default ConstraintViolations;
