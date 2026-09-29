/**
 * RuleOptimizerService — ranks the outcome of scheduling the SAME jobs under
 * each dispatching rule so the planner can pick the best sequencing strategy
 * ("optimization", as PlanetTogether / Opcenter APS call it).
 *
 * The route (POST /api/schedule/optimize) runs the finite-capacity engine once
 * per candidate rule and hands the resulting ScheduleMetrics here. Everything
 * in this file is PURE (no I/O) so it is unit-tested in isolation.
 *
 * Scoring: each metric is min-max normalised across the candidate runs, flipped
 * so higher-is-better, then combined with objective-specific weights into a
 * 0–100 composite. Rank 1 (highest score) is the recommendation.
 */

export type SchedulingRule = 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio';

export type OptimizeObjective = 'balanced' | 'on-time' | 'tardiness' | 'makespan' | 'setup';

/** Subset of ScheduleMetrics the optimizer reasons about. */
export interface RuleRunMetrics {
  totalJobsScheduled: number;
  jobsOnTime: number;
  jobsTardy: number;
  averageTardiness: number;   // days (lower better)
  resourceUtilization: number; // %   (higher better, within reason)
  overtimeHours: number;      // hours (lower better)
  criticalPathLength: number; // hours (lower better — makespan proxy)
  totalSetupTime: number;     // hours (lower better)
}

export interface RuleResult {
  rule: SchedulingRule;
  metrics: RuleRunMetrics;
  /** Optional note when a run failed or was skipped. */
  error?: string;
}

export interface RankedRuleResult extends RuleResult {
  onTimePct: number;   // 0..100
  score: number;       // 0..100 composite (higher better)
  rank: number;        // 1 = best
  recommended: boolean;
}

interface WeightSet {
  onTime: number;
  tardiness: number;
  makespan: number;
  setup: number;
  overtime: number;
  utilization: number;
}

const WEIGHTS: Record<OptimizeObjective, WeightSet> = {
  balanced:    { onTime: 0.35, tardiness: 0.25, makespan: 0.15, setup: 0.10, overtime: 0.10, utilization: 0.05 },
  'on-time':   { onTime: 0.70, tardiness: 0.30, makespan: 0.00, setup: 0.00, overtime: 0.00, utilization: 0.00 },
  tardiness:   { onTime: 0.30, tardiness: 0.70, makespan: 0.00, setup: 0.00, overtime: 0.00, utilization: 0.00 },
  makespan:    { onTime: 0.30, tardiness: 0.00, makespan: 0.70, setup: 0.00, overtime: 0.00, utilization: 0.00 },
  setup:       { onTime: 0.30, tardiness: 0.00, makespan: 0.00, setup: 0.70, overtime: 0.00, utilization: 0.00 },
};

export const onTimePct = (m: RuleRunMetrics): number =>
  m.totalJobsScheduled > 0 ? (m.jobsOnTime / m.totalJobsScheduled) * 100 : 0;

/**
 * Min-max normalise a series to 0..1. When every value is identical (or only
 * one candidate exists) each entry scores 1 — no rule is penalised for a
 * metric on which they don't differ.
 */
const normalise = (values: number[], higherIsBetter: boolean): number[] => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!isFinite(min) || !isFinite(max) || max === min) return values.map(() => 1);
  return values.map((v) => {
    const n = (v - min) / (max - min); // 0..1, 1 = largest
    return higherIsBetter ? n : 1 - n;
  });
};

/**
 * Rank rule results best-first. Runs that errored (no metrics) sort last with
 * score 0. Ties break by on-time %, then lower average tardiness, then a
 * stable preference order so output is deterministic.
 */
export function rankRuleResults(
  results: RuleResult[],
  objective: OptimizeObjective = 'balanced'
): RankedRuleResult[] {
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  if (ok.length === 0) {
    return results.map((r, i) => ({
      ...r, onTimePct: 0, score: 0, rank: i + 1, recommended: false,
    }));
  }

  const w = WEIGHTS[objective] || WEIGHTS.balanced;

  const nOnTime      = normalise(ok.map((r) => onTimePct(r.metrics)), true);
  const nTardiness   = normalise(ok.map((r) => r.metrics.averageTardiness), false);
  const nMakespan    = normalise(ok.map((r) => r.metrics.criticalPathLength), false);
  const nSetup       = normalise(ok.map((r) => r.metrics.totalSetupTime), false);
  const nOvertime    = normalise(ok.map((r) => r.metrics.overtimeHours), false);
  const nUtilisation = normalise(ok.map((r) => r.metrics.resourceUtilization), true);

  const scored = ok.map((r, i) => {
    const composite =
      w.onTime * nOnTime[i] +
      w.tardiness * nTardiness[i] +
      w.makespan * nMakespan[i] +
      w.setup * nSetup[i] +
      w.overtime * nOvertime[i] +
      w.utilization * nUtilisation[i];
    const totalWeight =
      w.onTime + w.tardiness + w.makespan + w.setup + w.overtime + w.utilization;
    return {
      ...r,
      onTimePct: Math.round(onTimePct(r.metrics) * 10) / 10,
      score: Math.round((totalWeight > 0 ? (composite / totalWeight) * 100 : 0) * 10) / 10,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.onTimePct !== a.onTimePct) return b.onTimePct - a.onTimePct;
    return a.metrics.averageTardiness - b.metrics.averageTardiness;
  });

  const ranked: RankedRuleResult[] = scored.map((r, i) => ({
    ...r, rank: i + 1, recommended: i === 0,
  }));

  // Append failed runs after the ranked ones.
  failed.forEach((r, i) => {
    ranked.push({
      ...r, onTimePct: 0, score: 0, rank: ranked.length + i + 1, recommended: false,
    });
  });

  return ranked;
}

/** Human-readable label for each rule (UI + logs). */
export const RULE_LABELS: Record<SchedulingRule, string> = {
  priority: 'Priority + Due Date',
  edd: 'Earliest Due Date (EDD)',
  fifo: 'First In First Out (FIFO)',
  spt: 'Shortest Processing Time (SPT)',
  'critical-ratio': 'Critical Ratio',
};

export const ALL_RULES: SchedulingRule[] = ['priority', 'edd', 'fifo', 'spt', 'critical-ratio'];
