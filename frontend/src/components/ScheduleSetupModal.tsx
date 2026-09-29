import React, { useState, useMemo, useEffect } from 'react';
import { Job } from '../types';
import type { ProductionMode } from '../types';
import { apiClient } from '../services/api';
import { toWeekValue, mondayFromWeekValue, addDays } from '../utils/weekWindow';

interface ScheduleSetupModalProps {
  open: boolean;
  onClose: () => void;
  onGenerate: (config: ScheduleConfig) => void;
  jobs: Job[];
  initialConfig: {
    schedulingRule: string;
    schedulingDirection: string;
    scheduleDateMode: string;
    horizonStart: string;
    horizonEnd: string;
  };
  loading: boolean;
  preSelectedJobIds?: string[];
}

export interface ScheduleConfig {
  schedulingRule: 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio';
  schedulingDirection: 'forward' | 'backward';
  scheduleDateMode: 'syspro' | 'manual';
  horizonStart: string;
  horizonEnd: string;
  anchorDateTime: string;
  selectedJobIds: string[];
  engineType: 'greedy' | 'cp-sat';
  cpSatWeights: { tardiness: number; makespan: number; changeover: number };
  cpSatTimeLimitSeconds: number;
  productionMode: ProductionMode;
  /** Frozen zone (firm time fence) in days — 0 disables it. */
  freezeHorizonDays: number;
}

// Scheduling is always forward (Op1 → Last) — the week horizon is filled
// from its Monday start.
const DIRECTION = 'forward' as const;

const ScheduleSetupModal: React.FC<ScheduleSetupModalProps> = ({
  open,
  onClose,
  onGenerate,
  jobs,
  initialConfig,
  loading,
  preSelectedJobIds,
}) => {
  const [rule, setRule] = useState(initialConfig.schedulingRule);
  const [dateMode, setDateMode] = useState(initialConfig.scheduleDateMode);
  const [horizonStart, setHorizonStart] = useState(initialConfig.horizonStart);
  const [horizonEnd, setHorizonEnd] = useState(initialConfig.horizonEnd);
  const [anchorDateTime, setAnchorDateTime] = useState('');
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());
  const [jobSearch, setJobSearch] = useState('');
  const [selectAll, setSelectAll] = useState(true);
  const [engineType, setEngineType] = useState<'greedy' | 'cp-sat'>('greedy');
  const [cpSatWeights, setCpSatWeights] = useState({ tardiness: 34, makespan: 33, changeover: 33 });
  const [cpSatTimeLimit, setCpSatTimeLimit] = useState(30);
  const [productionMode, setProductionMode] = useState<ProductionMode>('job-shop');
  const [freezeHorizonDays, setFreezeHorizonDays] = useState(0);
  const [cpSatHealth, setCpSatHealth] = useState<'checking' | 'up' | 'down'>('checking');
  const [cpSatHealthDetail, setCpSatHealthDetail] = useState<string>('');

  // Ping the CP-SAT sidecar whenever the modal opens so the user learns the
  // engine is unavailable BEFORE generating, not from a failed run.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCpSatHealth('checking');
    apiClient
      .get('/status/engines')
      .then((res) => {
        if (cancelled) return;
        const cpSat = res.data?.engines?.['cp-sat'];
        setCpSatHealth(cpSat?.available ? 'up' : 'down');
        setCpSatHealthDetail(cpSat?.detail || '');
        // Don't leave an unavailable engine selected.
        if (!cpSat?.available) {
          setEngineType((prev) => (prev === 'cp-sat' ? 'greedy' : prev));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCpSatHealth('down');
        setCpSatHealthDetail('Could not query engine status');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setRule(initialConfig.schedulingRule);
      // Default to the week horizon as the anchor so the chosen week is
      // actually filled (rather than each job sitting on its own Syspro date).
      setDateMode('manual');
      setHorizonStart(initialConfig.horizonStart);
      setHorizonEnd(initialConfig.horizonEnd);
      if (preSelectedJobIds && preSelectedJobIds.length > 0) {
        setSelectedJobs(new Set(preSelectedJobIds));
        setSelectAll(preSelectedJobIds.length >= jobs.length);
      } else {
        setSelectedJobs(new Set(jobs.map((j) => j.jobId)));
        setSelectAll(true);
      }
      setJobSearch('');
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      // Forward scheduling anchors at the start of the week horizon (Monday).
      setAnchorDateTime(`${initialConfig.horizonStart}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
      setProductionMode('job-shop');
      setFreezeHorizonDays(0);
    }
  }, [open, initialConfig, jobs, preSelectedJobIds]);

  const orderedJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    const filtered = !q
      ? [...jobs]
      : jobs.filter(
          (j) =>
            j.jobId.toLowerCase().includes(q) ||
            j.itemCode.toLowerCase().includes(q) ||
            (j.description || '').toLowerCase().includes(q)
        );

    const now = new Date();
    const parsedAnchor = anchorDateTime ? new Date(anchorDateTime) : null;
    const hasManualAnchor = !!parsedAnchor && !Number.isNaN(parsedAnchor.getTime());

    const getEffectiveDueDate = (job: Job) => new Date(job.dueDate);

    const getEffectiveReleaseDate = (job: Job) => {
      if (dateMode === 'manual' && hasManualAnchor) {
        return parsedAnchor as Date;
      }
      return new Date(job.releaseDate);
    };

    return filtered.sort((a, b) => {
      const aDuration = (a.operations || []).reduce((sum, op) => sum + (Number(op.duration) || 0), 0);
      const bDuration = (b.operations || []).reduce((sum, op) => sum + (Number(op.duration) || 0), 0);
      const aDue = getEffectiveDueDate(a).getTime();
      const bDue = getEffectiveDueDate(b).getTime();
      const aRelease = getEffectiveReleaseDate(a).getTime();
      const bRelease = getEffectiveReleaseDate(b).getTime();
      const aCriticalRatio = aDuration > 0 ? Math.max(0, aDue - now.getTime()) / (aDuration * 60000) : Number.POSITIVE_INFINITY;
      const bCriticalRatio = bDuration > 0 ? Math.max(0, bDue - now.getTime()) / (bDuration * 60000) : Number.POSITIVE_INFINITY;

      switch (rule) {
        case 'edd':
          return aDue - bDue;
        case 'fifo':
          return aRelease - bRelease;
        case 'spt':
          return aDuration - bDuration;
        case 'critical-ratio':
          return aCriticalRatio - bCriticalRatio;
        case 'priority':
        default:
          if ((a.priority || 0) !== (b.priority || 0)) {
            return (a.priority || 0) - (b.priority || 0);
          }
          return aDue - bDue;
      }
    });
  }, [jobs, jobSearch, rule, dateMode, anchorDateTime]);

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedJobs(new Set());
      setSelectAll(false);
    } else {
      setSelectedJobs(new Set(jobs.map((j) => j.jobId)));
      setSelectAll(true);
    }
  };

  const toggleJob = (jobId: string) => {
    setSelectedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const handlePickWeek = (weekValue: string) => {
    if (!weekValue) return;
    const monday = mondayFromWeekValue(weekValue);
    setHorizonStart(monday);
    setHorizonEnd((prev) => (prev && prev >= monday ? prev : addDays(monday, 6)));
  };

  const handleGenerate = () => {
    onGenerate({
      schedulingRule: rule as ScheduleConfig['schedulingRule'],
      schedulingDirection: DIRECTION,
      scheduleDateMode: dateMode as ScheduleConfig['scheduleDateMode'],
      horizonStart,
      horizonEnd,
      anchorDateTime,
      selectedJobIds: Array.from(selectedJobs),
      engineType,
      cpSatWeights,
      cpSatTimeLimitSeconds: cpSatTimeLimit,
      productionMode,
      freezeHorizonDays,
    });
  };

  if (!open) return null;

  const selectedCount = selectedJobs.size;
  const totalCount = jobs.length;

  return (
    <div className="schedule-setup-overlay" onClick={onClose}>
      <div className="schedule-setup-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-setup-title" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-setup-header">
          <h2 id="schedule-setup-title">Schedule Setup</h2>
          <button className="schedule-setup-close" onClick={onClose}>×</button>
        </div>

        <div className="schedule-setup-body">
          {/* Left column: Configuration */}
          <div className="schedule-setup-config">
            <div className="setup-section">
              <label className="setup-label">Schedule Week</label>
              <div className="setup-row">
                <div className="setup-field">
                  <span className="setup-field-label">Week (starts Monday)</span>
                  <input
                    type="week"
                    value={toWeekValue(horizonStart)}
                    onChange={(e) => handlePickWeek(e.target.value)}
                  />
                </div>
              </div>
              <div className="setup-hint">
                The schedule fills the selected week from its Monday. To span more than one week, set the end date in the ribbon’s Week bar.
              </div>
            </div>

            <div className="setup-section">
              <label className="setup-label">Frozen Zone</label>
              <div className="setup-row">
                <div className="setup-field">
                  <span className="setup-field-label">Firm time fence (days)</span>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    step={1}
                    value={freezeHorizonDays}
                    onChange={(e) => setFreezeHorizonDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
                  />
                </div>
              </div>
              <div className="setup-hint">
                {freezeHorizonDays > 0
                  ? `Operations from the last saved schedule starting within ${freezeHorizonDays} day${freezeHorizonDays === 1 ? '' : 's'} keep their exact slots — the engine schedules around them.`
                  : '0 = off. Set a fence to stop short-term operations from moving between runs (schedule nervousness).'}
              </div>
            </div>

            <div className="setup-section">
              <label className="setup-label">Sequencing Rule</label>
              <select className="setup-select" value={rule} onChange={(e) => setRule(e.target.value)}>
                <option value="priority">Priority</option>
                <option value="edd">Earliest Due Date</option>
                <option value="fifo">First In, First Out</option>
                <option value="spt">Shortest Processing Time</option>
                <option value="critical-ratio">Critical Ratio</option>
              </select>
            </div>

            <div className="setup-section">
              <label className="setup-label">Scheduling Engine</label>
              <div className="setup-row">
                <button
                  className={`setup-toggle ${engineType === 'greedy' ? 'active' : ''}`}
                  onClick={() => setEngineType('greedy')}
                >
                  Greedy (default)
                </button>
                <button
                  className={`setup-toggle ${engineType === 'cp-sat' ? 'active' : ''}`}
                  onClick={() => setEngineType('cp-sat')}
                  disabled={cpSatHealth === 'down'}
                  title={cpSatHealth === 'down' ? (cpSatHealthDetail || 'CP-SAT sidecar is not running') : undefined}
                >
                  CP-SAT (OR-Tools)
                  {cpSatHealth === 'checking' && ' …'}
                  {cpSatHealth === 'up' && ' ●'}
                  {cpSatHealth === 'down' && ' ○'}
                </button>
              </div>
              <div className="setup-hint">
                {engineType === 'greedy'
                  ? 'Fast priority-based finite-capacity scheduler.'
                  : 'Google OR-Tools CP-SAT — multi-objective optimisation. Requires the Python sidecar (cp-sat/).'}
              </div>
              {cpSatHealth === 'down' && (
                <div className="setup-hint setup-hint--warn">
                  ⚠ CP-SAT unavailable: {cpSatHealthDetail || 'the Python sidecar is not running'}.
                  Start it with <code>docker-compose up cp-sat</code> or <code>python cp-sat/main.py</code>.
                </div>
              )}
              {cpSatHealth === 'up' && engineType === 'cp-sat' && (
                <div className="setup-hint">✓ CP-SAT sidecar is online.</div>
              )}
            </div>

            {engineType === 'cp-sat' && (
              <div className="setup-section">
                <label className="setup-label">Objective Weights</label>
                <div className="setup-hint">Tune the relative importance of each objective (0 = ignore).</div>
                {(['tardiness', 'makespan', 'changeover'] as const).map((key) => (
                  <div className="setup-weight-row" key={key}>
                    <span className="setup-weight-label">
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={cpSatWeights[key]}
                      onChange={(e) =>
                        setCpSatWeights((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                      }
                      className="setup-weight-slider"
                    />
                    <span className="setup-weight-value">{cpSatWeights[key]}</span>
                  </div>
                ))}
                <div className="setup-weight-row">
                  <span className="setup-weight-label">Time limit (s)</span>
                  <input
                    type="range"
                    min={5}
                    max={300}
                    step={5}
                    value={cpSatTimeLimit}
                    onChange={(e) => setCpSatTimeLimit(Number(e.target.value))}
                    className="setup-weight-slider"
                  />
                  <span className="setup-weight-value">{cpSatTimeLimit}s</span>
                </div>
              </div>
            )}

            <div className="setup-section">
              <label className="setup-label">Production Mode</label>
              <div className="setup-row">
                <button
                  data-testid="pm-job-shop"
                  className={`setup-toggle ${productionMode === 'job-shop' ? 'active' : ''}`}
                  onClick={() => setProductionMode('job-shop')}
                >
                  Job shop
                </button>
                <button
                  data-testid="pm-flow-line"
                  className={`setup-toggle ${productionMode === 'flow-line' ? 'active' : ''}`}
                  onClick={() => setProductionMode('flow-line')}
                >
                  Continuous line
                </button>
                <button
                  data-testid="pm-mixed"
                  className={`setup-toggle ${productionMode === 'mixed' ? 'active' : ''}`}
                  onClick={() => setProductionMode('mixed')}
                >
                  Mixed
                </button>
              </div>
              {productionMode === 'flow-line' && (
                <div className="setup-hint setup-hint--info">
                  All operations of a job will run on the same production line. Assign a <strong>Line group</strong> to each resource in the Resources tab.
                </div>
              )}
              {productionMode === 'mixed' && (
                <div className="setup-hint setup-hint--info">
                  Jobs inherit the system default (job-shop) unless their <strong>productionMode</strong> field is set to <em>flow-line</em> in the import data.
                </div>
              )}
            </div>

            <div className="setup-section">
              <label className="setup-label">Date Anchor</label>
              <div className="setup-row">
                <button
                  className={`setup-toggle ${dateMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setDateMode('manual')}
                >
                  Fill the week
                </button>
                <button
                  className={`setup-toggle ${dateMode === 'syspro' ? 'active' : ''}`}
                  onClick={() => setDateMode('syspro')}
                >
                  Syspro Dates
                </button>
              </div>
              {dateMode === 'manual' && (
                <div className="setup-anchor-datetime">
                  <span className="setup-field-label">Schedule from</span>
                  <input
                    type="datetime-local"
                    value={anchorDateTime}
                    onChange={(e) => setAnchorDateTime(e.target.value)}
                  />
                </div>
              )}
              <div className="setup-hint">
                {dateMode === 'manual'
                  ? 'Jobs scheduled forward from the start of the selected week (adjust the exact date/time above).'
                  : 'Jobs scheduled using their original Syspro release/due dates within the horizon.'}
              </div>
            </div>
          </div>

          {/* Right column: Job selection */}
          <div className="schedule-setup-jobs">
            <div className="setup-section">
              <div className="setup-jobs-header">
                <label className="setup-label">Jobs to Schedule</label>
                <span className="setup-jobs-count">{selectedCount} / {totalCount} selected</span>
              </div>
              <div className="setup-jobs-toolbar">
                <input
                  type="text"
                  className="setup-job-search"
                  placeholder="Search jobs..."
                  value={jobSearch}
                  onChange={(e) => setJobSearch(e.target.value)}
                />
                <button className="setup-select-all-btn" onClick={handleSelectAll}>
                  {selectAll ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div className="setup-hint">The list below updates automatically to preview the scheduling order.</div>
              <div className="setup-job-list">
                {orderedJobs.map((job, index) => (
                  <label key={job.jobId} className={`setup-job-item ${selectedJobs.has(job.jobId) ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selectedJobs.has(job.jobId)}
                      onChange={() => toggleJob(job.jobId)}
                    />
                    <span className="setup-job-id">{index + 1}. {job.jobId}</span>
                    <span className="setup-job-item-code">{job.itemCode}</span>
                    <span className="setup-job-desc">{job.description || '—'}</span>
                    <span className="setup-job-qty">Qty: {job.quantity}</span>
                    <span className={`setup-job-status status-${String(job.status).toLowerCase()}`}>
                      {String(job.status)}
                    </span>
                  </label>
                ))}
                {orderedJobs.length === 0 && (
                  <div className="setup-job-empty">No jobs match your search.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="schedule-setup-footer">
          <button className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={loading || selectedCount === 0}
          >
            {loading ? 'Generating...' : `Generate Schedule (${selectedCount} jobs)`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScheduleSetupModal;
