import React, { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { Schedule } from '../types';
import './WhatIfPanel.css';
import { BarChart3, FileText, FlaskConical, Plus, Trash2 } from 'lucide-react';

interface WhatIfPanelProps {
  liveSchedule: Schedule | null;
  onCreateScenario: () => void;
  onClearScenario: () => void;
  scenarioSchedule: Schedule | null;
  scenarioLabel: string;
}

const WhatIfPanel: React.FC<WhatIfPanelProps> = ({
  liveSchedule,
  onCreateScenario,
  onClearScenario,
  scenarioSchedule,
  scenarioLabel,
}) => {
  const [activePanel, setActivePanel] = useState<'compare' | 'notes'>('compare');
  const [scenarioNote, setScenarioNote] = useState('');

  const diff = useMemo(() => {
    if (!liveSchedule || !scenarioSchedule) return null;
    const live = liveSchedule.metrics;
    const scen = scenarioSchedule.metrics;
    return {
      jobs: scen.totalJobsScheduled - live.totalJobsScheduled,
      onTime: scen.jobsOnTime - live.jobsOnTime,
      tardiness: scen.averageTardiness - live.averageTardiness,
      utilization: scen.resourceUtilization - live.resourceUtilization,
      overtime: scen.overtimeHours - live.overtimeHours,
      violations: scenarioSchedule.constraintViolations.length - liveSchedule.constraintViolations.length,
    };
  }, [liveSchedule, scenarioSchedule]);

  const fmtDiff = (val: number, inverse = false): React.ReactNode => {
    const better = inverse ? val < 0 : val > 0;
    const neutral = val === 0;
    const cls = neutral ? 'diff-neutral' : better ? 'diff-better' : 'diff-worse';
    const sign = val > 0 ? '+' : '';
    return <span className={`diff-badge ${cls}`}>{sign}{val.toFixed(1)}</span>;
  };

  return (
    <div className="whatif-panel">
      <div className="whatif-header">
        <h3>What-If Scenario Analysis</h3>
        <p>Create a sandbox copy of the current schedule, modify it, then compare results.</p>
      </div>

      <div className="whatif-toolbar">
        {!scenarioSchedule ? (
          <button
            className="whatif-btn whatif-btn-create"
            onClick={onCreateScenario}
            disabled={!liveSchedule}
          >
            <Plus size={13} className="ui-icon" aria-hidden="true" /> Create What-If Scenario from Current Schedule
          </button>
        ) : (
          <>
            <div className="whatif-scenario-badge">
              <FlaskConical size={13} className="ui-icon" aria-hidden="true" /> Scenario Active: <strong>{scenarioLabel}</strong>
            </div>
            <button className="whatif-btn whatif-btn-clear" onClick={onClearScenario}>
              <Trash2 size={13} className="ui-icon" aria-hidden="true" /> Clear Scenario
            </button>
          </>
        )}
      </div>

      {scenarioSchedule && (
        <div className="whatif-body">
          <div className="whatif-tabs">
            <button
              className={`whatif-tab ${activePanel === 'compare' ? 'active' : ''}`}
              onClick={() => setActivePanel('compare')}
            >
              <BarChart3 size={13} className="ui-icon" aria-hidden="true" /> Metric Comparison
            </button>
            <button
              className={`whatif-tab ${activePanel === 'notes' ? 'active' : ''}`}
              onClick={() => setActivePanel('notes')}
            >
              <FileText size={13} className="ui-icon" aria-hidden="true" /> Scenario Notes
            </button>
          </div>

          {activePanel === 'compare' && diff && (
            <div className="whatif-compare-grid">
              <div className="whatif-compare-row header">
                <span>Metric</span>
                <span>Live</span>
                <span>Scenario</span>
                <span>Delta</span>
              </div>

              <div className="whatif-compare-row">
                <span>Jobs Scheduled</span>
                <span>{liveSchedule!.metrics.totalJobsScheduled}</span>
                <span>{scenarioSchedule.metrics.totalJobsScheduled}</span>
                <span>{fmtDiff(diff.jobs)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Jobs On-Time</span>
                <span>{liveSchedule!.metrics.jobsOnTime}</span>
                <span>{scenarioSchedule.metrics.jobsOnTime}</span>
                <span>{fmtDiff(diff.onTime)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Avg Tardiness (d)</span>
                <span>{liveSchedule!.metrics.averageTardiness.toFixed(2)}</span>
                <span>{scenarioSchedule.metrics.averageTardiness.toFixed(2)}</span>
                <span>{fmtDiff(diff.tardiness, true)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Utilization (%)</span>
                <span>{Math.round(liveSchedule!.metrics.resourceUtilization)}%</span>
                <span>{Math.round(scenarioSchedule.metrics.resourceUtilization)}%</span>
                <span>{fmtDiff(diff.utilization)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Overtime (h)</span>
                <span>{Math.round(liveSchedule!.metrics.overtimeHours)}h</span>
                <span>{Math.round(scenarioSchedule.metrics.overtimeHours)}h</span>
                <span>{fmtDiff(diff.overtime, true)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Violations</span>
                <span>{liveSchedule!.constraintViolations.length}</span>
                <span>{scenarioSchedule.constraintViolations.length}</span>
                <span>{fmtDiff(diff.violations, true)}</span>
              </div>

              <div className="whatif-compare-row">
                <span>Schedule Date</span>
                <span>{format(new Date(liveSchedule!.scheduledDate), 'dd/MM HH:mm')}</span>
                <span>{format(new Date(scenarioSchedule.scheduledDate), 'dd/MM HH:mm')}</span>
                <span>—</span>
              </div>
            </div>
          )}

          {activePanel === 'notes' && (
            <div className="whatif-notes">
              <label>Scenario notes / justification:</label>
              <textarea
                className="whatif-textarea"
                value={scenarioNote}
                onChange={(e) => setScenarioNote(e.target.value)}
                placeholder="Document what changes you made in this scenario and why..."
                rows={6}
              />
            </div>
          )}
        </div>
      )}

      {!scenarioSchedule && liveSchedule && (
        <div className="whatif-empty-hint">
          <div className="whatif-hint-icon"><FlaskConical size={13} className="ui-icon" aria-hidden="true" /> </div>
          <p>A What-If scenario is a sandbox copy of the live schedule.</p>
          <p>You can modify the scenario without affecting the live plan, then compare KPIs side-by-side.</p>
        </div>
      )}
    </div>
  );
};

export default WhatIfPanel;
