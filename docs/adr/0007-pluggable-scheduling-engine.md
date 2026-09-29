# ADR 0007 — Pluggable Scheduling Engine via ISchedulingEngine Interface

**Date:** 2026-05
**Status:** Accepted — extended with CP-SAT backend (2026-05)

## Context

The initial scheduler was a single concrete class (`SchedulingEngine`) implementing a greedy, priority-ordered forward-scheduling algorithm (ADR 0004). As the product matures, customers have asked for alternative sequencing strategies:

- **EDD (Earliest Due Date)** — minimises maximum lateness
- **SPT (Shortest Processing Time)** — maximises throughput
- **Critical-Ratio** — dynamically re-orders jobs by urgency

Adding each as a branch inside `SchedulingEngine` would make the class harder to maintain and test. ROADMAP item #61 specified a pluggable engine abstraction.

## Decision

Introduce an `ISchedulingEngine` TypeScript interface and a factory function `createSchedulingEngine`.

```typescript
export interface ISchedulingEngine {
  schedule(context: SchedulingContext): Promise<Schedule>;
}

export type EngineType = 'greedy' | 'cp-sat';

export function createSchedulingEngine(
  type: EngineType = 'greedy',
  constraintManager?: ConstraintManager
): ISchedulingEngine;
```

The existing `SchedulingEngine` class implements `ISchedulingEngine` unchanged. The factory is the only public entry point; callers never import `SchedulingEngine` directly.

`EngineType` is a string union. Additional engines are registered by extending the union and adding a `case` in the factory's switch statement — no changes to routes or the worker thread.

The `engineType` field is exposed in the `/schedule/generate` request body and forwarded through the worker-thread payload so the caller can select an engine per request.

## CP-SAT Engine (added 2026-05)

`EngineType = 'cp-sat'` is now live. It routes scheduling to a Python microservice
(`cp-sat/main.py`) built on [Google OR-Tools CP-SAT](https://developers.google.com/optimization/reference/python/sat/python/cp_model).

### Architecture

```
Browser ──POST /api/schedule/generate (engineType='cp-sat')──►
  Express (Node.js)
    └─ scheduleWorker.ts (worker_thread)
         └─ CpSatEngine.schedule()
              └─ POST http://CP_SAT_URL/solve ──►
                   FastAPI (Python)
                     └─ ortools.sat CpModel().Solve()
```

### Multi-Objective Optimisation

The sidecar minimises a weighted combination of three objectives:

| Objective  | Default weight | Meaning |
|------------|---------------|---------|
| Tardiness  | 34/100        | Weighted sum of job lateness (hours × priority) |
| Makespan   | 33/100        | Time from horizon start to last operation end |
| Changeover | 33/100        | Reserved for future sequence-dependent setup tracking |

Weights are passed per-request via `cpSatWeights: { tardiness, makespan, changeover }` (0–100 each). A time limit (`cpSatTimeLimitSeconds`, 5–300 s, default 30) caps solver wall-clock time; the best feasible solution found within the limit is returned.

### Fallback

If the sidecar is unreachable, `CpSatEngine` returns a `Draft` schedule with all jobs `Unschedulable` and a single `Critical` `ScheduleDateViolation` describing the error. The UI surfaces this as a constraint violation, not a hard 500.

### Deployment

Development:
```bash
cd cp-sat
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 5050
```

Docker Compose:
```bash
docker-compose up -d cp-sat-sidecar
```
Set `CP_SAT_URL=http://cp-sat-sidecar:5050` in the backend environment.

## Consequences

**Positive**
- Adding a new algorithm requires one new class (implementing `ISchedulingEngine`) and one `case` in the factory — no changes to the API layer.
- Each engine can be unit-tested in isolation via the interface, without the full application context.
- The `engineType` field in the API and OpenAPI spec gives UI a clean surface to expose alternative engines when they are added.
- Worker-thread compatibility is preserved: the factory is called inside the worker after the context is deserialised.
- CP-SAT runs in a separate Python process; a crash in the solver does not affect the Node.js process.

**Negative**
- The `SchedulingContext` type is shared across all engines. New engine requirements (e.g., look-ahead windows for beam search) must be added to the shared context, which could bloat it over time.
- CP-SAT requires the Python sidecar to be running. In environments where Python/Docker is unavailable, only `greedy` works.
- OR-Tools CP-SAT scales well to ~500 operations within 30 s. Very large instances (1000+ ops) may need a higher time limit or a decomposition strategy.

## Rejected Alternatives

**Strategy pattern via constructor injection** — passing the strategy function directly instead of a factory. Rejected because it makes the worker-thread serialisation more complex (functions cannot cross thread boundaries).

**Plugin registry (dynamic requires)** — loading engine modules at runtime by name. Rejected as premature; a static `switch` statement is simpler and type-safe at the current scale.

**Embedding OR-Tools via `node-addon-api`** — calling CP-SAT from Node directly. Rejected due to the complexity of native addons and the difficulty of distributing pre-built binaries. The HTTP sidecar pattern keeps the concerns well separated.


## Context

The initial scheduler was a single concrete class (`SchedulingEngine`) implementing a greedy, priority-ordered forward-scheduling algorithm (ADR 0004). As the product matures, customers have asked for alternative sequencing strategies:

- **EDD (Earliest Due Date)** — minimises maximum lateness
- **SPT (Shortest Processing Time)** — maximises throughput
- **Critical-Ratio** — dynamically re-orders jobs by urgency

Adding each as a branch inside `SchedulingEngine` would make the class harder to maintain and test. ROADMAP item #61 specified a pluggable engine abstraction.

## Decision

Introduce an `ISchedulingEngine` TypeScript interface and a factory function `createSchedulingEngine`.

```typescript
export interface ISchedulingEngine {
  schedule(context: SchedulingContext): Promise<Schedule>;
}

export type EngineType = 'greedy';

export function createSchedulingEngine(
  type: EngineType = 'greedy',
  constraintManager?: ConstraintManager
): ISchedulingEngine;
```

The existing `SchedulingEngine` class implements `ISchedulingEngine` unchanged. The factory is the only public entry point; callers never import `SchedulingEngine` directly.

`EngineType` is a string union that starts as `'greedy'` only. Additional engines are registered by extending the union and adding a `case` in the factory's switch statement — no changes to routes or the worker thread.

The `engineType` field is exposed in the `/schedule/generate` request body and forwarded through the worker-thread payload so the caller can select an engine per request.

## Consequences

**Positive**
- Adding a new algorithm requires one new class (implementing `ISchedulingEngine`) and one `case` in the factory — no changes to the API layer.
- Each engine can be unit-tested in isolation via the interface, without the full application context.
- The `engineType` field in the API and OpenAPI spec gives UI a clean surface to expose alternative engines when they are added.
- Worker-thread compatibility is preserved: the factory is called inside the worker after the context is deserialised.

**Negative**
- The `SchedulingContext` type is shared across all engines. New engine requirements (e.g., look-ahead windows for beam search) must be added to the shared context, which could bloat it over time.
- Only `greedy` exists today. The abstraction adds a layer before there is more than one implementation.

## Rejected Alternatives

**Strategy pattern via constructor injection** — passing the strategy function directly instead of a factory. Rejected because it makes the worker-thread serialisation more complex (functions cannot cross thread boundaries).

**Plugin registry (dynamic requires)** — loading engine modules at runtime by name. Rejected as premature; a static `switch` statement is simpler and type-safe at the current scale.
