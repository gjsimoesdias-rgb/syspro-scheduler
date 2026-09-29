# ADR 0004 — Greedy finite-capacity scheduling algorithm

**Date:** 2026-04-05  
**Status:** Accepted (see roadmap #61 for pluggable engine plan)

## Context

The core of the scheduler is an algorithm that assigns operations to time slots on workcentres/resources respecting capacity, setup times, material availability, skill constraints, and job priority.

Approaches evaluated:
- **Greedy priority-based** — iterate jobs in priority order, for each operation find the earliest feasible slot.
- **CP-SAT / OR-Tools** — constraint programming, provably optimal within the model.
- **Genetic algorithm** — population-based meta-heuristic.
- **Simulated annealing** — local search.

## Decision

Greedy priority-based forward/backward scheduling (`SchedulingEngine.ts`).

## Rationale

1. **Speed** — greedy runs in O(J × O × S) where J = jobs, O = ops per job, S = slots scanned. For 100-job batches it completes in < 2 s. CP-SAT on the same instance can take minutes without careful model tuning.
2. **Determinism** — same inputs always produce the same output, which planners expect.
3. **Explainability** — a planner can trace exactly why each op landed where it did via the constraint violation log.
4. **Time to value** — greedy was implementable in one sprint. CP-SAT integration is estimated at XL effort.

## Consequences

**Positive**
- Fast, deterministic, auditable.
- Extensible via `ConstraintManager` without touching core slot logic.

**Negative**
- Not globally optimal — late-arriving high-priority jobs may be placed sub-optimally if capacity was consumed by earlier lower-priority jobs.
- No makespan minimisation or multi-objective scoring.

## Migration plan

Roadmap #61 introduces an abstract `ISchedulingEngine` interface. The greedy implementation becomes the default. An OR-Tools CP-SAT backend can be added as an optional Python sidecar without changing the API contract.
