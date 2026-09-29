# ADR 0002 — Greedy finite-capacity engine is the default scheduling path

**Date:** 2026-05-11
**Status:** Accepted
**Deciders:** Engineering team

---

## Context

Two scheduling engines are available:

- **Greedy** (`SchedulingEngine.ts`): iterates jobs in priority order and
  places each operation into the earliest productive slot on the chosen
  resource, respecting calendars, capacity, and predecessor constraints.
  Runs in-process, typically completes in < 500 ms for 200 jobs.

- **CP-SAT** (`CpSatSchedulingEngine.ts` + `cp-sat/main.py`): formulates the
  scheduling problem as a constraint programming model and solves it to
  near-optimality using Google OR-Tools. Runs as an out-of-process sidecar
  (see ADR 0001). Typical solve time 5–60 s depending on problem size and
  `cpSatTimeLimitSeconds`.

The product must work reliably in environments where the CP-SAT sidecar may
not be installed (lightweight deployments, CI, demo machines).

---

## Decision

**Greedy is the default engine.** The planner may switch to CP-SAT via the
`ScheduleSetupModal` engine toggle, which is only enabled when the sidecar
health-check confirms the sidecar is reachable.

In code: the `schedule.ts` route reads `body.engine` from the request. If
absent or `'greedy'`, it instantiates `SchedulingEngine`. If `'cp-sat'`, it
instantiates `CpSatSchedulingEngine`. The factory is in `schedule.ts` rather
than a separate registry so the decision point is visible in one place.

---

## Rationale

| Criterion | Greedy default | CP-SAT default |
|---|---|---|
| Works without Python | Yes | No |
| Latency (200 jobs) | < 500 ms | 5–60 s |
| Schedule quality | Good (priority-ordered) | Near-optimal |
| Sidecar dependency | None | Required |
| Suitable for CI / smoke tests | Yes | Requires sidecar container |

For the typical planner workflow — iteratively tweaking constraints and
regenerating — the greedy engine's sub-second response time is more useful than
a 30-second near-optimal solve.  CP-SAT is reserved for overnight batch runs or
cases where the planner explicitly needs to minimise tardiness across a large job
set with conflicting priorities.

---

## Consequences

**Positive**
- The scheduler is self-contained: it runs, produces a usable schedule, and
  can be demonstrated without installing Python or OR-Tools.
- CI runs the full greedy path without any additional infrastructure.
- Response times stay sub-second for typical workloads, enabling rapid
  constraint-iteration workflows.

**Negative / mitigation required**
- Greedy schedules are not globally optimal. Jobs with equal priority are
  placed first-come-first-served; a planner chasing overall tardiness
  minimisation must switch to CP-SAT manually.
- The `ScheduleSetupModal` engine toggle must clearly communicate that CP-SAT
  requires the sidecar and will take longer. The UI shows the engine label and
  a solve-time estimate.
- If CP-SAT is selected but the sidecar is down, `CpSatSchedulingEngine`
  catches the fetch error and returns a `Critical` `ConstraintViolation`.
  The route **does not** silently fall back to greedy, because silent fallback
  would confuse the planner (they asked for CP-SAT). The error message tells
  them to check the sidecar.

---

## Alternatives considered and rejected

**CP-SAT as default, greedy as fallback** — rejected because it makes the
scheduler depend on Python being installed, breaking lightweight and CI
deployments.

**Single unified engine** — rejected because the two engines have fundamentally
different trade-offs (speed vs. quality) that cannot be merged into one
algorithm without losing both.
