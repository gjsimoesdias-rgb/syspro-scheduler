/**
 * GanttLegend — legend overlay panel for MachineGanttBoard.
 * Extracted from MachineGanttBoard.tsx (#43).
 */
import React from 'react';

type ColorMode = 'workcentre' | 'lateness' | 'status' | 'critical';

const WORKCENTRE_COLORS = [
  '#3e7fe7', '#e45c3c', '#2db87a', '#d4a017', '#9b59b6',
  '#1abc9c', '#e67e22', '#e91e63', '#00bcd4', '#8bc34a',
  '#ff5722', '#607d8b', '#795548', '#ff9800', '#009688',
];

interface Props {
  show: boolean;
  colorMode: ColorMode;
  workcentres: string[];
  onClose: () => void;
}

const GanttLegend: React.FC<Props> = ({ show, colorMode, workcentres, onClose }) => {
  if (!show) return null;

  return (
    <div className="gantt-legend-panel">
      <div className="gantt-legend-title">
        Legend —{' '}
        {colorMode === 'workcentre'
          ? 'Workcentre Colors'
          : colorMode === 'lateness'
          ? 'Lateness'
          : colorMode === 'status'
          ? 'Job Status'
          : 'Critical Path'}
      </div>

      {colorMode === 'workcentre' &&
        workcentres.slice(0, 10).map((wc, i) => (
          <div key={wc} className="gantt-legend-item">
            <span
              className="gantt-legend-dot"
              style={{ background: WORKCENTRE_COLORS[i % WORKCENTRE_COLORS.length] }}
            />
            {wc}
          </div>
        ))}

      {colorMode === 'lateness' && (
        <>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#10b981' }} />
            On Time
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#f59e0b' }} />
            At Risk (&lt;8h buffer)
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#ef4444' }} />
            Late
          </div>
        </>
      )}

      {colorMode === 'status' && (
        <>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#3b8fdc' }} />
            Scheduled OK
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#ef4444' }} />
            Constraint Violation
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#6b7280' }} />
            Unschedulable
          </div>
        </>
      )}

      {colorMode === 'critical' && (
        <>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#3e7fe7' }} />
            Normal (slack &gt; 1h)
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#f59e0b' }} />
            Tight (slack &lt; 1h)
          </div>
          <div className="gantt-legend-item">
            <span className="gantt-legend-dot" style={{ background: '#ef4444' }} />
            Critical (no slack)
          </div>
        </>
      )}

      <div className="gantt-legend-divider" />
      <div className="gantt-legend-title" style={{ marginTop: 6 }}>
        Operation Phases
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot phase-legend-setup" />
        Setup (striped)
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot phase-legend-run" />
        Run (solid)
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot phase-legend-queue" />
        Queue (amber)
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot phase-legend-move" />
        Move (purple)
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot" style={{ outline: '2px dashed var(--status-bad, #dc2626)', outlineOffset: -2, background: 'transparent' }} />
        Finishes after due date (dashed border)
      </div>
      <div className="gantt-legend-item">
        <span className="gantt-legend-dot" style={{ background: '#198754', borderRadius: 1, height: 5 }} />
        Shift time (strip along the lane top)
      </div>

      <button className="gantt-legend-close" onClick={onClose}>
        ✕
      </button>
    </div>
  );
};

export default GanttLegend;
