/**
 * OptimizerPanel — Sequencing Optimizer.
 *
 * Runs the finite-capacity engine over the SAME jobs under every dispatching
 * rule (EDD, FIFO, SPT, Critical Ratio, Priority) and ranks the outcomes so the
 * planner can pick the strategy that best fits their objective — the
 * "optimization" workflow of PlanetTogether / Opcenter APS.
 *
 * Read-only: POST /api/schedule/optimize never saves; the live schedule is not
 * touched. "Apply" just sets the chosen rule so the next Generate uses it.
 */
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Trophy, Play, Wand2, Info, Clock, CheckCircle2, Factory, Wrench, GitCommitHorizontal } from 'lucide-react';
import { apiClient, apiErrorMessage } from '../services/api';
import { useUiStore, type SchedulingRule } from '../stores/uiStore';
import './OptimizerPanel.css';

type Objective = 'balanced' | 'on-time' | 'tardiness' | 'makespan' | 'setup';

interface RankedResult {
  rule: SchedulingRule;
  label: string;
  onTimePct: number;
  score: number;
  rank: number;
  recommended: boolean;
  error?: string;
  metrics: {
    totalJobsScheduled: number;
    jobsOnTime: number;
    jobsTardy: number;
    averageTardiness: number;
    resourceUtilization: number;
    overtimeHours: number;
    criticalPathLength: number;
    totalSetupTime: number;
  };
}

interface OptimizeResponse {
  objective: Objective;
  jobsConsidered: number;
  recommendedRule: SchedulingRule | null;
  results: RankedResult[];
}

const OBJECTIVES: Array<{ value: Objective; label: string; hint: string }> = [
  { value: 'balanced',  label: 'Balanced',        hint: 'On-time, tardiness, makespan, setup & overtime' },
  { value: 'on-time',   label: 'On-Time Delivery', hint: 'Maximise the % of jobs finishing by due date' },
  { value: 'tardiness', label: 'Least Tardiness',  hint: 'Minimise average days late' },
  { value: 'makespan',  label: 'Shortest Makespan', hint: 'Minimise the longest job chain' },
  { value: 'setup',     label: 'Least Setup',      hint: 'Minimise total setup / changeover time' },
];

const OptimizerPanel: React.FC = () => {
  const setSchedulingRule = useUiStore((s) => s.setSchedulingRule);
  const activeRule = useUiStore((s) => s.schedulingRule);

  const [objective, setObjective] = useState<Objective>('balanced');
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<OptimizeResponse | null>(null);

  const runOptimize = async () => {
    try {
      setRunning(true);
      setData(null);
      const res = await apiClient.post('/schedule/optimize', { objective });
      setData(res.data);
      if (res.data?.recommendedRule) {
        const rec = res.data.results.find((r: RankedResult) => r.recommended);
        toast.success(`Best for “${objective}”: ${rec?.label ?? res.data.recommendedRule}`);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Optimization failed'));
    } finally {
      setRunning(false);
    }
  };

  const applyRule = (rule: SchedulingRule, label: string) => {
    setSchedulingRule(rule);
    toast.success(`Sequencing rule set to ${label}. Run Generate to apply it to the live schedule.`);
  };

  const fmt = (n: number, unit = '') => `${Math.round(n * 10) / 10}${unit}`;

  return (
    <div className="opt-panel">
      <div className="opt-header">
        <h3><Wand2 size={15} aria-hidden="true" /> Sequencing Optimizer</h3>
        <p>
          Runs every dispatching rule over the same jobs and ranks the outcomes.
          Read-only — nothing is saved. Pick the winner and hit Generate to apply it.
        </p>
      </div>

      <div className="opt-controls">
        <label className="opt-objective">
          <span>Optimize for</span>
          <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)} disabled={running}>
            {OBJECTIVES.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <span className="opt-objective-hint">
          <Info size={12} aria-hidden="true" /> {OBJECTIVES.find((o) => o.value === objective)?.hint}
        </span>
        <button className="btn btn-primary opt-run" onClick={runOptimize} disabled={running}>
          <Play size={13} aria-hidden="true" /> {running ? 'Running all rules…' : 'Compare rules'}
        </button>
      </div>

      {!data && !running && (
        <div className="opt-empty">
          <Trophy size={26} aria-hidden="true" />
          <p>Run the comparison to see which sequencing rule wins for your objective.</p>
          <span className="opt-empty-sub">Requires a live SYSPRO connection — the engine runs once per rule.</span>
        </div>
      )}

      {running && (
        <div className="opt-empty">
          <span className="spinner" /> Scheduling under each rule…
        </div>
      )}

      {data && (
        <>
          <div className="opt-summary">
            Compared <strong>{data.results.filter((r) => !r.error).length}</strong> rules over{' '}
            <strong>{data.jobsConsidered}</strong> jobs. Recommended:{' '}
            <strong>{data.results.find((r) => r.recommended)?.label ?? '—'}</strong>.
          </div>

          <div className="opt-cards">
            {data.results.map((r) => (
              <div key={r.rule} className={`opt-card ${r.recommended ? 'winner' : ''} ${r.error ? 'failed' : ''}`}>
                <div className="opt-card-top">
                  <span className="opt-rank">{r.error ? '—' : `#${r.rank}`}</span>
                  <span className="opt-card-label">
                    {r.recommended && <Trophy size={13} aria-hidden="true" />} {r.label}
                  </span>
                  {r.rule === activeRule && <span className="opt-active-chip">active</span>}
                </div>

                {r.error ? (
                  <div className="opt-card-error">Run failed: {r.error}</div>
                ) : (
                  <>
                    <div className="opt-score">
                      <div className="opt-score-bar">
                        <div className="opt-score-fill" style={{ width: `${r.score}%` }} />
                      </div>
                      <span className="opt-score-num">{fmt(r.score)}</span>
                    </div>
                    <div className="opt-metrics">
                      <span title="On-time delivery"><CheckCircle2 size={12} aria-hidden="true" /> {fmt(r.onTimePct, '%')}</span>
                      <span title="Average tardiness (days)"><Clock size={12} aria-hidden="true" /> {fmt(r.metrics.averageTardiness, 'd')}</span>
                      <span title="Makespan — longest job chain (hours)"><GitCommitHorizontal size={12} aria-hidden="true" /> {fmt(r.metrics.criticalPathLength, 'h')}</span>
                      <span title="Total setup / changeover (hours)"><Wrench size={12} aria-hidden="true" /> {fmt(r.metrics.totalSetupTime, 'h')}</span>
                      <span title="Resource utilization"><Factory size={12} aria-hidden="true" /> {fmt(r.metrics.resourceUtilization, '%')}</span>
                    </div>
                    <button
                      className={`btn btn-sm opt-apply ${r.recommended ? 'btn-primary' : ''}`}
                      onClick={() => applyRule(r.rule, r.label)}
                      disabled={r.rule === activeRule}
                    >
                      {r.rule === activeRule ? 'Current rule' : 'Apply this rule'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="opt-note">
            Scores are min-max normalised across the compared rules and weighted by the selected objective —
            they rank the rules against each other, not against an absolute target.
          </div>
        </>
      )}
    </div>
  );
};

export default OptimizerPanel;
