/**
 * ISchedulingEngine — the contract every scheduling algorithm must fulfil.
 *
 * Consumers (route handlers, worker threads) depend on this interface, not on
 * the concrete GreedySchedulingEngine class.  Adding a new algorithm is a
 * matter of:
 *   1. Creating a class that implements ISchedulingEngine
 *   2. Adding a new case to createSchedulingEngine()
 *   3. Passing the desired algorithm type through SchedulingContext
 */

import ConstraintManager from './ConstraintManager';
import { SchedulingEngine } from './SchedulingEngine';
import { CpSatSchedulingEngine } from './CpSatEngine';
import type { SchedulingContext } from './SchedulingEngine';
import type { Schedule } from '../types';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ISchedulingEngine {
  /**
   * Run the scheduling algorithm over the supplied context and return a fully
   * populated Schedule (job schedules, resource loads, metrics, violations).
   */
  schedule(context: SchedulingContext): Promise<Schedule>;
}

// ─── Engine type registry ─────────────────────────────────────────────────────

/** Identifiers for all supported scheduling algorithms. */
export type EngineType =
  | 'greedy'   // Default: priority-based greedy finite-capacity scheduler
  | 'cp-sat'   // Google OR-Tools CP-SAT (Python sidecar — cp-sat/main.py)
  // Future:
  // | 'genetic' // Genetic algorithm
  ;

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct and return a scheduling engine by algorithm type.
 *
 * @param type            The algorithm to use. Defaults to `'greedy'`.
 * @param constraintManager  Optional constraint manager injected into engines
 *                           that support it.
 */
export function createSchedulingEngine(
  type: EngineType = 'greedy',
  constraintManager?: ConstraintManager
): ISchedulingEngine {
  switch (type) {
    case 'cp-sat':
      return new CpSatSchedulingEngine();
    case 'greedy':
    default:
      return new SchedulingEngine(constraintManager);
  }
}
