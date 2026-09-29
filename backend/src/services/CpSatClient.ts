/**
 * @deprecated CpSatClient was a standalone HTTP client.
 *
 * The canonical CP-SAT integration is the `CpSatSchedulingEngine` class in
 * `./CpSatEngine.ts`, which implements `ISchedulingEngine` and is dispatched
 * through the `createSchedulingEngine('cp-sat', ...)` factory in
 * `./ISchedulingEngine.ts`. Route handlers don't need to know the sidecar's
 * HTTP shape — they call the factory and treat the result like any other
 * engine.
 *
 * This file is kept only to surface the redirect; nothing else should
 * import it. Delete safely once you're confident no checked-out branch
 * still references it.
 */

export { CpSatSchedulingEngine as CpSatClient } from './CpSatEngine';
export type { ObjectiveWeights as CpSatSolveOptions } from './CpSatEngine';
