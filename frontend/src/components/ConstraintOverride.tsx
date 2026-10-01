/**
 * ConstraintOverride - Allows users to override constraints and recalculate schedule
 */

import React, { useState } from 'react';
import { CheckCircle2, Lightbulb } from 'lucide-react';
import { ConstraintViolation } from '../types';
import './ConstraintOverride.css';

interface ConstraintOverrideProps {
  violations: ConstraintViolation[];
  onOverride?: (violationIds: string[], recalculate: boolean) => void;
}

interface OverrideSelection {
  [violationId: string]: boolean;
}

export default function ConstraintOverride(props: ConstraintOverrideProps) {
  const { violations, onOverride } = props;
  const [selected, setSelected] = useState<OverrideSelection>({});
  const [recalulate, setRecalculate] = useState(false);

  const handleToggle = (violationId: string) => {
    setSelected(prev => ({
      ...prev,
      [violationId]: !prev[violationId]
    }));
  };

  const handleSelectAll = () => {
    if (Object.values(selected).some(v => !v)) {
      setSelected(violations.reduce((acc, v) => ({ ...acc, [v.violationId]: true }), {}));
    } else {
      setSelected({});
    }
  };

  const handleApply = () => {
    const selectedIds = Object.keys(selected).filter(id => selected[id]);
    onOverride?.(selectedIds, recalulate);
  };

  const severityGroups = {
    Critical: violations.filter(v => v.severity === 'Critical'),
    Warning: violations.filter(v => v.severity === 'Warning'),
    Info: violations.filter(v => v.severity === 'Info')
  };

  const selectedCount = Object.values(selected).filter(v => v).length;

  return (
    <div className="constraint-override">
      <div className="override-header">
        <h3>Constraint Management</h3>
        <p>Override constraints and recalculate schedule</p>
      </div>

      <div className="override-toolbar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={selectedCount === violations.length}
            onChange={handleSelectAll}
          />
          Select All
        </label>
        <span className="selection-count">
          {selectedCount} / {violations.length} selected
        </span>
      </div>

      <div className="violations-list">
        {Object.entries(severityGroups).map(([severity, vios]) =>
          vios.length > 0 && (
            <div key={severity} className="violation-group">
              <h4 className={`group-title severity-${severity.toLowerCase()}`}>
                {severity} ({vios.length})
              </h4>
              <div className="group-items">
                {vios.map(violation => (
                  <div key={violation.violationId} className={`violation-item severity-${violation.severity.toLowerCase()}`}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={selected[violation.violationId] || false}
                        onChange={() => handleToggle(violation.violationId)}
                      />
                      <div className="violation-info">
                        <div className="violation-type">{violation.type}</div>
                        <div className="violation-desc">{violation.description}</div>
                        {violation.suggestedAction && (
                          <div className="violation-action"><Lightbulb size={13} className="ui-icon" aria-hidden="true" /> {violation.suggestedAction}</div>
                        )}
                      </div>
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </div>

      {violations.length === 0 && (
        <div className="empty-state">
          <p><CheckCircle2 size={14} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 4, color: '#10b981' }} /> No constraint violations detected.</p>
        </div>
      )}

      <div className="override-actions">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={recalulate}
            onChange={e => setRecalculate(e.target.checked)}
          />
          <span>Recalculate schedule after override</span>
        </label>
        <button
          className="btn btn-primary"
          onClick={handleApply}
          disabled={selectedCount === 0}
        >
          Apply Overrides ({selectedCount})
        </button>
      </div>
    </div>
  );
}
