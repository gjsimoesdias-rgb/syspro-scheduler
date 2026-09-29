# Improvement plan — 2026-05-12

Picks up from `REVIEW_AND_ROADMAP.md` and `AUDIT_2026-05-11.md`. The
codebase is in much better shape than 72 hours ago: 72/72 backend tests
pass across 6 suites (up from 5/5 in 1 suite), the CP-SAT sidecar
end-to-end is wired, persistent app state is on the DB, validators
and the audit-log service are in.

Two things drive this plan:

1. **What's still genuinely outstanding** — the audit list trimmed to
   what actually needs doing now.
2. **The new feature you asked for** — a production-mode selector so
   the same scheduler can serve **job-shop** factories (each op picks
   its best resource) and **continuous-line / flow** factories (every
   op of a job stays on the line that the first op was assigned to).

The plan is sprint-shaped: 5 sprints, each ≈ 1 week of focused work,
plus a strategic tail.

---

## Where things stand

| Surface | State |
|---|---|
| Backend tests | 6 suites, 72 cases — `SchedulingEngine`, `ConstraintManager`, `AppStateStore`, `CpSatEngine`, `getJobMaterialPlans`, `calendar` |
| Frontend tests | 2 suites, 20 cases — `undoRedoManager`, `smoke` (covers `ErrorBoundary`, `DarkModeContext`, `ScheduleVersionHistory`, `BomDetailModal`) |
| Optimisation engines | Greedy + CP-SAT via `ISchedulingEngine` factory + Python sidecar |
| Persistence | `AppStateStore` backed by `sch_AppState`; hydrated at boot |
| Materials | Warehouse-aware, time-phased POs, other-job WIP holds; schedule-sequence depletion |
| Logging / errors | Pino + traceId, centralised handler, `/health/ready` |
| Build / CI | Cross-platform `copy-migrations.mjs`, `.github/workflows/ci.yml` exists |
| Theme | Token-driven light + dark, lucide icons on the surfaces that have been touched |
| Auth | Middleware (`requireAuth`/`requireRole`) imported in routes — wiring incomplete |

**Test pass count:** 72 backend + 20 frontend = **92 cases / 8 suites**, all green.

---

## Sprint 1 — Round out the test net (1 week)

Coverage is the single biggest production risk. Three new suites + the
one zero-coverage critical service.

### S1.1 — `APSDatabaseService` test suite *(M)*

Today: zero tests on the service that writes back to SYSPRO (`WipMaster`,
`WipJobAllLab`, APS sprocs). The only thing standing between a regression
and your live database is your eyes.

Build a `MockTransaction` test double that captures every
`queryWithParams` call. Cover:

- `exportSchedule` calls `refreshApsCache` first, then opens a transaction.
- Empty `jobSchedules` → no writes inside the transaction.
- A failing `writeJobSchedule` re-throws so the transaction rolls back.
- `WipMaster.UPDATE` runs after every job's APS sproc, not before.
- `populateSchedulerRecordSummary` uses **only parameterised** SQL.
- `@@ROWCOUNT` zero on `WipMaster` triggers a rollback for that job.
- All date values are sent as ISO strings, not as raw `Date`s.

Target: 12 cases.

### S1.2 — Schedule-route smoke tests via `supertest` *(M)*

Today: the route layer has zero tests. Stand up Express in-process with a
mocked `sysproDb`/`schedulerDb` and exercise:

- `POST /api/schedule/generate` returns a schedule when DB is connected.
- Returns 503 when DB is absent.
- Forwards `engineType` to the worker payload (mock the worker).
- `POST /api/schedule/:id/approve` returns 401 without auth, 200 with.
- `GET /api/jobs/:id/bom-detail` returns the expected shape for a known job.

Target: 8-10 cases.

### S1.3 — Frontend RTL coverage on the BOM modal drill-down *(S)*

Today: the modal has one smoke test that proves it mounts. Add:

- Filter toggle ("All" / "Issues only") shows / hides OK rows.
- Click a chevron → warehouse and incoming-PO sub-panels appear.
- Overdue PO promise dates render the red "overdue" tag.
- ESC closes the modal.

Target: 6 cases.

### S1.4 — Make CI fail on test errors *(S)*

`.github/workflows/ci.yml` runs the tests but the test step status isn't
required for merge. Add a status check + branch protection rule.

### S1.5 — Drop the lingering `act()` warning *(S)*

Already wrapped the render in `await act(async () => …)` in
`smoke.test.tsx`. Next run should be silent. Confirm.

**Sprint 1 deliverable:** ~26 new test cases across 3 suites, CI gates merges
on test pass, no warnings in the test output.

---

## Sprint 2 — Production-mode selector (job shop vs flow line) (1-2 weeks)

The new feature. Designed to be additive — job shop stays the default and
nothing changes for existing users.

### Concept

A factory falls into one of three modes:

| Mode | Behaviour |
|---|---|
| `job-shop` *(default)* | Each operation independently picks its best resource. Current behaviour. |
| `flow-line` | Once op[0] of a job is placed on resource R, every subsequent op of that job must use a resource in the **same line group** as R. |
| `mixed` | Per-job flag overrides — some items flow, others job-shop. |

A *line group* is a tagged set of resources that, taken together, form a
production line. Examples: bottling line {Filler, Capper, Labeller,
Palletiser}, assembly line {Station-1, Station-2, …, Station-N}.
Resources in the same line group can hand work between each other; a job
in flow mode picks a line group at op[0] and is locked to it.

### S2.1 — Data model *(S)*

```ts
// shared/types.ts and backend/src/types.ts
export type ProductionMode = 'job-shop' | 'flow-line' | 'mixed';

export interface Resource {
  // …existing fields…
  lineGroupId?: string;     // NEW — null/undefined = not part of a line
}

export interface Job {
  // …existing fields…
  productionMode?: ProductionMode;  // overrides system mode in 'mixed'
}

export interface SchedulingContext {
  // …existing fields…
  productionMode: ProductionMode;   // global default
}
```

Migration `002_line_groups.sql`:

```sql
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID('sch_ResourceDefinitions')
                 AND name = 'lineGroupId')
BEGIN
  ALTER TABLE sch_ResourceDefinitions ADD lineGroupId NVARCHAR(50) NULL;
END
```

### S2.2 — Engine implementation — greedy path *(M)*

In `SchedulingEngine.scheduleJob`:

```ts
let lockedLineGroupId: string | null = null;
const mode = job.productionMode || context.productionMode;
const flowMode = mode === 'flow-line';

for (const op of sortedOps) {
  const slot = this.findBestOperationSlot(op, earliestStart, job, context, {
    // NEW: filter candidate resources by line group when the job is locked
    requireLineGroupId: flowMode ? lockedLineGroupId : null,
  });
  if (!slot) { /* …emit ConstraintViolation, break… */ }
  if (flowMode && !lockedLineGroupId) {
    const resource = context.resources.get(slot.resourceId);
    lockedLineGroupId = resource?.lineGroupId || null;
  }
  // …record slot, advance predecessorEnd, etc.
}
```

Same change to `scheduleJobBackward`. `findBestOperationSlot` already
iterates candidate resources — just add the line-group filter at the top
of that loop:

```ts
for (const resource of candidateResources) {
  if (requireLineGroupId && resource.lineGroupId !== requireLineGroupId) continue;
  // …
}
```

Emit a new `ConstraintViolation` type `'LineGroupViolation'` (severity:
Warning) when no in-group resource has capacity, so the planner sees
*why* the job stalled rather than just "no slot found".

### S2.3 — CP-SAT path *(M)*

In `CpSatEngine.toSolveRequest`, add per-job `line_group_id` and
per-resource `line_group_id`. The Python sidecar needs a matching
constraint (`cp-sat/main.py`):

```python
# In flow-line mode, every op of a job must be assigned to a resource
# whose line_group_id matches the job's line_group_id (or any resource
# if the job has none).
for job_id, ops in ops_by_job.items():
    job = job_map[job_id]
    if not job.line_group_id:
        continue
    for op in ops:
        qualified_in_group = [
            r.resource_id for r in req.resources
            if r.line_group_id == job.line_group_id
            and r.workcentre_id == op.workcentre_id
        ]
        # …constrain the op's resource literal to that subset…
```

### S2.4 — Backend route & validators *(S)*

`scheduleValidators.ts` already validates the generate-schedule body.
Extend the schema to accept `productionMode: 'job-shop' | 'flow-line' | 'mixed'`
(defaults to `'job-shop'`) and `lineGroupOverrides?: Record<jobId, lineGroupId>`.

### S2.5 — Frontend UI — ScheduleSetupModal *(S)*

Add a second row of toggles below the existing engine selector:

```
Production mode:  [ Job shop ◯ ]  [ Continuous line ● ]  [ Mixed ◯ ]
```

When `Continuous line` is selected:

- Show a small info banner: "All operations of a job will run on the
  same production line."
- Show a fallback line selector for jobs with no explicit line tag.

When `Mixed`:

- Show a table of jobs with a per-row line-group picker.

### S2.6 — Frontend UI — Resource definition tab *(S)*

Each resource row gains a "Line group" column. Free-text or dropdown
populated from existing values. Save through `/api/resources/definitions`
via the existing `setLocal` helper so it lands in `sch_AppState`.

### S2.7 — Tests *(M)*

- `SchedulingEngine` — flow-line lock survives multi-op jobs; falls back
  to ConstraintViolation when no in-group resource has capacity.
- `CpSatEngine` — request payload carries `line_group_id`; sidecar
  enforces same-group assignment (test against the sidecar; expand the
  smoke test to start the Python service if available).
- `ScheduleSetupModal` — radio toggle persists; production mode flows
  to the API call.

Target: 10 cases.

### S2.8 — Docs *(S)*

- `docs/production-modes.md` — explain when to use each mode, with
  a worked example.
- Update README's "Architecture" section with the new mode.

**Sprint 2 deliverable:** Production-mode selector live end-to-end, with
tests, validators, UI, and docs.

---

## Sprint 3 — Finish the UI usability backlog (1 week)

Things planners actually feel:

### S3.1 — Highlight constraint violations on the Gantt *(M)*

When a row in the Constraints tab is selected, pulse the corresponding
op bar(s) red on the Gantt and scroll the timeline to it.

### S3.2 — Replace silent `.slice(0, 500)` with virtualised lists *(S)*

`App.tsx:3342` truncates the workcentre table silently. Either show
a "120 of 487 — load more" badge or pull in `react-window` and render
the full set. Same for the jobs grid pagination.

### S3.3 — Multi-select drag + keyboard alternative *(M)*

Ctrl/Shift+Click selects multiple op bars. Drag the group together.
Arrow keys move the selected group by ±1 day; Shift+Arrow by ±1 hour.

### S3.4 — Schedule version restore actually restores *(S)*

Today `ScheduleVersionHistory` "restores" by swapping the in-memory
schedule object. Wire it to `POST /api/schedule/load-version/:id` and
update the audit log.

### S3.5 — Hard overtime rejection in the slot finder *(M)*

`findBestOperationSlot` currently lets overtime placements through and
warns afterwards. Add a `rejectIfBudgetExceeded` short-circuit so an op
that would breach `maxOvertimePerDay` doesn't get the slot in the first
place. Greedy path only; the CP-SAT solver already optimises around
overtime cost.

---

## Sprint 4 — App.tsx Zustand split, phase 1 (1-2 weeks)

The 3,500-line god component is still the biggest source of state-management
bugs. Start with the smallest possible store and prove the pattern.

### S4.1 — Stand up `useUiStore` *(M)*

Migrate non-schedule state: dark mode, current main tab, current
sub-tab, panel widths, sidebar collapsed flag, search filters,
keyboard shortcut registry. ~12 `useState` calls become a single
zustand store.

### S4.2 — Stand up `useScheduleStore` *(L)*

The bigger lift: current schedule, schedule-version history, undo/redo
manager, highlighted job, locked operations. Migrate `App.tsx` to read
from the store; child components keep receiving props for the first pass.

### S4.3 — App.tsx slim-down *(L)*

Once stores are stable, App.tsx becomes a `<Layout>` with `<Header>`,
`<MainTabs>`, `<Ribbon>`, `<ContentTabs>`, `<StatusBar>` and the modals.
The 3,500-line component should drop to under 500 lines pure layout.

---

## Sprint 5 — Auth, audit, observability (1-2 weeks)

### S5.1 — Finish auth wiring *(M)*

`requireAuth` and `requireRole` are imported but the actual identity
source isn't connected. Pick:

- **Local mode**: a small env-driven token map for on-prem deploys.
- **Windows-integrated**: `passport-windowsauth`.
- **OIDC**: `passport-azure-ad` or generic OIDC.

Apply `requireRole('approver')` to `/api/schedule/:id/approve` and the
export endpoint; `requireRole('reviewer')` to `/api/schedule/generate`.

### S5.2 — Surface the audit log *(S)*

`AuditLogService` writes; build a History tab that reads
`sch_AuditLog` and renders a feed: who did what, when, traceId.

### S5.3 — Replace remaining `console.log` calls in routes *(S)*

`schedule.ts` still has `console.log` calls inside route handlers.
Replace with `req.log.info(...)` so the traceId is on every line.

### S5.4 — Per-resource availability windows in CP-SAT *(M)*

Today `CpSatEngine.toSolveRequest` sends `availability_windows: []` per
resource — the OR-Tools sidecar treats every minute as available. Wire
the actual calendar windows through so flow-line and job-shop both
respect calendars under CP-SAT.

---

## Strategic tail

These remain real, but each is multi-week and best scoped individually:

- **Move off Create-React-App to Vite** — faster dev, smaller bundles,
  enables code splitting per route.
- **OpenAPI spec + generated TS client** to replace `services/api.ts`.
- **Real-time replan signals** — listen to SYSPRO CDC / polling; push
  schedule updates via SSE.
- **Scenario branching** — `WhatIfPanel` is shallow; build named
  scenarios that can be promoted.
- **Mobile shop-floor view** — read-only mobile-first route showing
  today's schedule per workcentre.
- **ADRs** — `docs/adr/0001-cp-sat-as-sidecar.md`,
  `0002-greedy-as-default.md`, `0003-no-orm.md`,
  `0004-flow-line-via-line-groups.md`.

---

## Acceptance gate

Every sprint deliverable must pass:

```cmd
npm run lint           :: 0 warnings, 0 errors
npm run test           :: both suites pass
npm run build          :: backend + frontend
npm start              :: banner appears, /health/ready returns 200
```

The CI workflow blocks merge until those four green-light.

---

## Recommended order

1. **Sprint 1 first.** Tests are the foundation; touching anything else
   without coverage is gambling.
2. **Sprint 2 second.** Production-mode is the highest-value feature
   ask you have right now; planners notice it immediately.
3. **Sprint 3 third.** Visible UX wins.
4. **Sprint 4 fourth.** Architecture — only when the app is stable.
5. **Sprint 5 fifth.** Auth and observability close out the
   production-readiness story.

Pick one and let me know — I can start any of them straight away.
