# ADR 0009 — Flow-Line Production Mode via Line Groups

**Date:** 2026-05  
**Status:** Accepted

## Context

The initial scheduler (ADR 0004) assigns each operation independently to
whichever resource has the earliest available slot — the classic **job-shop**
model. This works well when every workcentre has multiple interchangeable
machines.

Some customer sites operate **continuous-flow production lines**: a discrete
set of machines (Filler → Capper → Labeller → Palletiser) that must run a
job together. Placing op[0] on Filler-A and op[1] on Capper-B (which belongs
to a different line) is physically impossible or causes severe handoff delays.

The scheduler needed to support this without breaking existing job-shop
deployments.

## Decision

Introduce a **line group** concept:

1. Each `Resource` gains an optional `lineGroupId: string | undefined`.
   Resources sharing the same `lineGroupId` form a production line.

2. A new `ProductionMode` union type (`'job-shop' | 'flow-line' | 'mixed'`)
   controls scheduling behaviour:
   - `job-shop` (default): existing behaviour, no restriction.
   - `flow-line`: once op[0] of a job is placed, every subsequent op of
     that job is restricted to resources whose `lineGroupId` matches the
     one assigned to op[0].
   - `mixed`: per-job `productionMode` override; some jobs flow, others job-shop.

3. `findBestOperationSlot` accepts a `requireLineGroupId` parameter. When
   set, it skips any candidate resource that does not belong to the required
   group and emits a `LineGroupViolation` constraint if no in-group resource
   has capacity.

4. Line groups are stored in `sch_ResourceDefinitions.lineGroupId` (added via
   migration `002_line_groups.sql`) and persisted through `app.locals` /
   `sch_AppState` using the existing `setLocal` helper.

5. The frontend `ScheduleSetupModal` exposes a three-way radio button
   ("Job shop / Continuous line / Mixed") that maps to `productionMode`.
   The `ResourceDefinitionTab` gains a "Line group" column for tagging.

## Consequences

**Positive**
- Continuous-line customers can schedule accurately without hacks.
- The job-shop default is unchanged; existing configs require zero migration.
- `LineGroupViolation` gives planners actionable feedback (which line ran out
  of capacity) rather than a silent "no slot found".
- Both the greedy and CP-SAT paths enforce the same constraint.

**Negative / risks**
- A misconfigured `lineGroupId` (typo, missing tag on one resource) silently
  degrades to a `LineGroupViolation` on every job — planners need clear
  error messages.
- `mixed` mode requires per-job configuration; the UI for large job lists
  (100+ jobs) can become unwieldy. A bulk "assign to line" action is deferred.
- The CP-SAT sidecar must receive `line_group_id` on both job and resource
  objects; the Python contract must be kept in sync with TypeScript changes.

## Alternatives considered

- **Hard-code line constraints in resource definitions** (e.g., only allow
  Filler-A → Capper-A as a successor rule): inflexible; breaks when lines are
  reconfigured. Rejected.
- **Separate "line scheduler" endpoint**: duplicates engine logic and doubles
  the test surface. Rejected.
- **Constraint-only approach** (add a ConstraintManager rule that rejects
  cross-line placements after the fact): the engine would still place ops and
  then emit violations, never producing a valid schedule. Rejected.
