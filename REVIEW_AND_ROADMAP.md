# Syspro Scheduler — Full Engineering Review & Roadmap

**Reviewed:** 2026-05-06
**Scope:** entire repo at `C:\Users\Goncalo Dias\SchedulerNEW_01042026`
**Audit method:** four parallel deep-reviewers covered backend services, backend routes/infra, frontend, build/test/security/devops, and the SYSPRO/SQL data layer; this document synthesises their findings into one prioritised plan.

This supersedes `ENHANCEMENT_PLAN.md` — that document was correct as of Week 1, but a lot has shipped since. Where this conflicts with the original, this wins.

---

## Executive summary

The scheduler is a **feature-complete prototype with production-grade ambitions**. The hot path works: a planner can hit `http://localhost:3000/`, generate a finite-capacity schedule against live SYSPRO data, drag operations on the Gantt, see material availability per BOM line, and export back to SYSPRO inside one transaction.

What's holding it back, in order of severity:

1. **Test coverage is the single biggest production risk.** ~12 unit tests for a system that touches financial-impact tables in SYSPRO. No integration tests, no E2E, no API contract tests.
2. **Two god components (App.tsx and MachineGanttBoard.tsx)** make every change risky. App.tsx has 47+ `useState` hooks; MachineGanttBoard re-renders on every parent state change.
3. **Half-finished features ship behind disabled UI** — bulk import, schedule approval, sequence-dependent setup, skill matching are all stubbed with no warning to the planner.
4. **No CI/CD** — anything can land on `main` without lint/test/build verification.
5. **A real list of concrete bugs** (stale closures, listener leaks, hardcoded overtime cutoff, dead `ConstraintManager`) that will bite under heavy use.

The good news: **the foundations laid in Weeks 1-3 (parameterised SQL, transactional writeback, secure env handling, structured logging, error boundary, design tokens, durable `app.locals`)** mean the scaffolding is ready. The roadmap below is overwhelmingly about **finishing what's started**, not rewriting from scratch.

---

## Where the codebase actually is

```
       Browser (React 18 SPA)
          │  HTTP /api/*   ──── x-trace-id propagated end-to-end
          ▼
       Express (port 3000) ──── pino-http structured logs
       │
       ├── /health  /health/ready
       ├── /api/jobs       ──── SysproDatabaseService (read SYSPRO)
       ├── /api/resources
       ├── /api/schedule   ──── worker thread → SchedulingEngine
       │                          ↑
       │                          │  context (jobs, resources,
       │                          │  workcentres, materialPlan)
       │                          ▼
       │                       writeback in single SQL tx via
       │                       APSDatabaseService → Syspro WipMaster /
       │                       WipJobAllLab + aps.* LYNQ-compat layer
       │
       └── app.locals (cache) ── persisted to sch_AppState in SCHEDULER DB
```

The architecture is sound. The execution gaps are below.

---

## Findings by surface

Citations are `file:line`.

### Backend services & engine

**Real bugs**

- `SchedulingEngine.recordOperationInLoads` (line ~1080) flags overtime overages but the slot is already committed in `findBestOperationSlot`; the warning has no effect on placement.
- `SchedulingEngine.findBestOperationSlot` line 867: `isOvertime = setupStart.getHours() >= 18 || runEnd.getHours() < 6` — hardcoded 6am-6pm definition, ignores actual shift hours. A 14:00-22:00 shift has its last 4 hours wrongly counted as "normal".
- `SchedulingEngine.scheduleJobBackward` builds operationSchedules in reverse, then sorts forward at line 661 — never verifies that op[i].plannedEnd <= op[i+1].plannedStart, so backward schedules can violate precedence under specific calendars.
- `ConstraintManager` is instantiated in `schedule.ts:184` but never passed to the engine — 320 lines of dead code with a misleading `isWithinWorkingHours()` stub that hardcodes 6am-10pm.
- `APSDatabaseService.cleanupClosedOperations(dayOffset)` is called from `schedule.ts:454` but exists in the service — call works, but the parameter contract (`dayOffset: number = 0`) means passing `1` will silently drop yesterday's records. Quietly destructive on a misconfigured cron.
- Material shortage emissions in `SchedulingEngine.checkMaterialAvailability` push one violation per shortage line — no dedup by `jobId+componentCode`. Re-running the engine produces duplicates.
- `getJobMaterialPlans` calls `getOpenJobAllocations(jobId)` per job inside its loop → N+1 queries (100 jobs = 100 extra round-trips).

**Architecture issues**

- `SchedulingEngine` is 1,150+ lines in one class. Slot-finding, sort logic, capacity tracking, overtime accounting, and metrics all share state.
- `SysproDatabaseService` is 700+ lines with three-level fallback chains for schema variants. Refactoring is dangerous.
- No layering between routes and services. `schedule.ts` directly orchestrates `SysproDatabaseService` + `ConstraintManager` + `SchedulingEngine` + `APSDatabaseService` + worker spawn.
- Worker thread serialisation (`scheduleWorker.ts:18-25`) manually re-hydrates Date objects from ISO strings. Forgetting one field silently produces NaN downstream.

### Backend routes & infra

- `/api/schedule/:scheduleId/approve` (`schedule.ts:411`) returns a hardcoded `{status: 'Approved'}` — never updates the database. Schedules stay "Draft" forever.
- Most POST/PUT routes have **no request-body validation** — a malformed payload reaches deep service code before failing with a confusing error.
- `app.locals` was the durability blackhole; now backed by `sch_AppState` (Week 3 / cleanup pass), but only `importedJobs`, `importedOperations`, and `constraintOverrides` actually call `appState.set()`. `resourceDefinitions`, `shiftTemplates`, and `alternativeGroups` are read-only paths today; if anything ever writes them, persistence won't follow without route changes.
- Only the request-line is structured-logged. Inside route handlers, `console.log` calls remain (`schedule.ts:151`, `:160`, `:174`, `:183` etc.). The traceId doesn't appear on those lines, so a planner-reported error can't be traced.
- `requireEnv()` only fails fast for `SYSPRO_DB_USER`/`PASSWORD` and `SCHEDULER_DB_USER`/`PASSWORD` when auth-mode=sql. Other required env vars (`SYSPRO_DB_SERVER`, `SCHEDULER_DB_NAME`) silently fall through to defaults.

### Frontend

**Real bugs**

- `App.tsx:633-658` — keyboard shortcuts capture `schedule` and other state in a `useEffect` with empty deps; subsequent updates are invisible to the registered handlers.
- `App.tsx:1982-2019` — `openJobContextMenu()` adds a global click listener every time it opens; never removes them. Listener count climbs the longer the session runs.
- `App.tsx:113-116` — `boardIntervalStart`/`boardIntervalEnd` initialise from `new Date()` once at mount. Hours-long sessions display dates from when the page was first loaded.
- `App.tsx:412-446` — `loadJobsAndResources()` has no cancellation flag. Concurrent invocations race; the slower one wins.
- `MachineGanttBoard.tsx:127-136` — `resourceMetaById` `useMemo` depends on `[resources]`, but `resources` array identity is unstable from App.tsx; the memo is effectively defeated.
- `App.tsx:1077, 1087, 2968` — hardcoded `.slice(0, 120)` and `.slice(0, 250)` silently truncate long lists with no UI badge.

**Performance**

- 47 `useState` calls in `App.tsx`. Every state change re-renders the whole tree.
- 102+ inline `onClick` arrow functions inside the App.tsx render. Every render allocates new function refs, defeating child memoisation.
- `MachineGanttBoard` is 1,000 lines, no `React.memo`, expensive `useMemo` blocks.
- Job grid renders up to 120 rows in a `<table>` with no virtualisation.
- BOM modal lines table renders all rows without windowing.
- `exportService.exportToPDF()` actually downloads HTML; `Blob` URLs never `revokeObjectURL()` → memory leak across exports.

**State & service issues**

- `zustand` is in `frontend/package.json` but not used anywhere.
- `undoRedoManager` is created but never connected to the schedule-mutating actions (drag-drop, approvals, deletes) — the undo button is decorative.
- `keyboardShortcuts.ts` default handlers are `console.log` stubs; `App.tsx` doesn't override them all.
- `bulkImportService.parseCSV()` doesn't handle escaped double quotes (`""`).
- `exportService` HTML report doesn't sanitise `description` fields → if a constraint description contains `<script>`, the downloaded report would execute it.
- `api.ts` `getBomDetail` URL-encodes the jobId; sibling routes don't. Inconsistent.

**a11y**

- Tree expand toggles (`App.tsx:2815`) have no `role="button"`, `aria-expanded`, or `tabIndex`. Screen readers can't see them.
- All modals (BomDetailModal, ConstraintOverrideModal) lack `role="dialog"`, focus-trap, focus-restore on close.
- Lateness encoded only by colour. Colourblind users have no fallback.
- Search inputs have placeholders but no associated `<label>`.
- Some text-on-bg combos in dark mode hit ~4.2:1 contrast (below WCAG AA).
- Gantt has no keyboard alternative for drag.

**CSS**

- `App.css` is 2,327 lines with **duplicate selectors** (e.g. `.aps-gantt-panel` defined four separate times). Last-write-wins behaviour creates baffling cascade bugs.
- ErrorBoundary uses inline `var(--bg-primary, #f5f6f8)` fallbacks for tokens that don't exist in `theme.css` (only `--bg-base`, `--bg-canvas`, etc.). The fallback hex is what actually renders in the boundary's empty state.
- `index.css` still uses a `.dark-mode` class hook from before the `data-theme` token system was introduced. Doesn't break anything but adds confusion.

### SYSPRO / SQL surface

**Strong points**

- Parameterisation is **clean across the entire backend** — no string-concat SQL on user-controlled data anywhere (the `populateSchedulerRecordSummary` issue from Week 1 is fixed; `withTransaction` properly isolates writes).
- `withTransaction` rollback is correctly implemented including rollback-failure handling.
- Every UPDATE in `APSDatabaseService` checks `@@ROWCOUNT` and throws on zero rows.
- Schema-version drift is mitigated by `OBJECT_ID()` and `COL_LENGTH()` guards on every read query, with three-level fallback chains for things like `WipJobAllMat` → `BomStructure` → `BomBillOfMaterials`.

**Risks**

- N+1 on `getOpenJobAllocations` per job, as noted above.
- `MERGE` upserts in `AppStateStore` and APS writeback don't use `WITH (HOLDLOCK)` consistently — under concurrent writers there's a small race window where two `MERGE` statements both INSERT.
- Migrations are ad-hoc: `001_app_state.sql` is auto-applied via `AppStateStore.ensureTable`, but `create_aps_lynq_compat_objects.sql` and `create_sysprouser.sql` must be run manually. No registry of which scripts have been applied.
- `create_sysprouser.sql` and `create_db_user.sql` contain plaintext passwords in source. Need to be replaced with templates that read from env or a vault.
- `set_static_port.sql` hardcodes `MSSQL16.SQLEXPRESS04` instance name — fragile.
- Recommended indexes that don't exist: `WipJobAllLab(Job, TRY_CONVERT(int, Operation))`, `WipMaster(Complete, Priority, JobDeliveryDate)`.

### Build / test / DevOps

- **Backend `build` script copies migrations using `xcopy /E /I /Y`** — Windows-only. CI on Linux/macOS will fail. Replace with Node-based copy (`fs.cpSync` or a tiny script).
- No GitHub Actions / no CI of any kind.
- Backend Dockerfile is single-stage and ships dev dependencies (`ts-jest`, ESLint, etc.) into production.
- Frontend Dockerfile bakes `REACT_APP_API_URL=http://localhost:3000/api` — wrong inside Docker Compose, where it should be `http://scheduler-backend:3000/api`.
- `docker-compose.yml` pins `mcr.microsoft.com/mssql/server:latest` — drift hazard. Pin to `2022-CU14-ubuntu-22.04` or similar.
- Two near-duplicate utilities: `ConfigApp/` and `TCPEnabler/`. Both modify Windows registry to enable SQL Server TCP/IP. Both hardcode `SQLEXPRESS04` as the instance name.
- 12 total unit tests across backend + frontend. No integration tests, no E2E.
- No pre-commit hooks, no commit-msg conventions, no PR template.
- `installer/setup-wizard.js` works but is the only entry point that knows how to test connections — there's a duplicate, simpler `test-connection.js` that does subset of the same job. Consolidate.

### Documentation

- Eight markdown files at the repo root, plus `DOCUMENTATION_INDEX.md` that navigates them. Coverage is excellent; coherence is medium.
- Some content overlaps three or more files (feature lists in `QUICK_START_GUIDE.md`, `FINAL_SUMMARY.md`, `README.md`).
- `README.md` API endpoint section drifted (refers to `localhost:3000` for the React dev server, which is now `:3001`).
- No formal API reference. The README links to `/docs/API.md` which doesn't exist.
- No ADRs (Architecture Decision Records). Reasoning behind big choices (CRA vs Vite, ad-hoc migrations vs Umzug, ConstraintManager existence) is buried in chat history.

---

## Roadmap — task by task

Priorities:
- **P0** — ship-blockers, real bugs, data-integrity risks.
- **P1** — important quality issues, tests, large refactors needed before more features land.
- **P2** — polish, UX, devx.
- **P3** — strategic / long-horizon.

Effort: **S** ≤ ½ day · **M** 1-2 days · **L** 3-5 days · **XL** > 1 week.

For each task: `[#ID] Title (Priority / Effort)` then a short brief.

### P0 — fix before next demo

```
[1]  Fix Windows-only build script                                 (P0 / S)
     backend/package.json:7 uses `xcopy /E /I /Y …`. Replace with
     a small `scripts/copy-migrations.mjs` (fs.cpSync) so CI on
     Linux works. Without this, no CI is possible.

[2]  Wire ConstraintManager into the engine, or delete it          (P0 / M)
     ConstraintManager is instantiated in schedule.ts:184 but
     never passed to the engine. Either pass it through and
     replace the in-engine isWithinWorkingHours/checkOvertime
     logic with calls to it, or delete the file. 320 lines of
     dead code is worse than no abstraction.

[3]  Hardcoded overtime cutoff is wrong                            (P0 / M)
     SchedulingEngine.findBestOperationSlot:867 treats hours
     >=18 or <6 as overtime. Replace with the per-resource
     calendar's productive-window check (already fits the
     `fitsProductiveWindow` API) — anything outside scheduled
     shifts is overtime.

[4]  Fix backward-scheduling precedence                            (P0 / M)
     scheduleJobBackward sorts after the loop, doesn't validate
     that op[i].end <= op[i+1].start. Add a post-loop validation
     that emits a Critical ConstraintViolation and falls back to
     forward scheduling if the chain is invalid.

[5]  /api/schedule/:scheduleId/approve actually approves           (P0 / S)
     Today returns a hardcoded JSON. UPDATE sch_ScheduleVersion
     SET status='Approved' WHERE scheduleId=@id, write an audit
     row, and return the updated record.

[6]  Stop accepting Docker `mssql/server:latest`                   (P0 / S)
     Pin to a specific tag, e.g. `2022-CU14-ubuntu-22.04`.

[7]  Fix Docker Compose REACT_APP_API_URL                          (P0 / S)
     frontend/Dockerfile bakes localhost:3000; in Compose it
     should be scheduler-backend:3000. Switch to runtime config
     via window.__APS_CONFIG__ or build-time arg.

[8]  Replace plaintext passwords in *.sql                          (P0 / S)
     create_sysprouser.sql, create_db_user.sql carry plaintext.
     Convert to .sql.template + a tiny `scripts/render-sql.mjs`
     that interpolates from .env. Add the rendered output to
     .gitignore.

[9]  Add a CI baseline                                             (P0 / M)
     `.github/workflows/ci.yml` running on push + PR:
       - npm ci
       - npm run lint
       - npm run test
       - npm run build
     This is the single highest-leverage change after #1.

[10] Sanitize HTML report exports                                  (P0 / S)
     exportService HTML report interpolates description fields
     directly. If SYSPRO description contains `<script>`, the
     downloaded HTML executes it. Run every untrusted string
     through a safe `escapeHtml()`.

[11] Listener leak in job context menu                             (P0 / S)
     App.tsx:1982-2019 attaches a global click listener every
     time the menu opens, never removes. Wrap in
     useEffect/useCallback with cleanup.

[12] Stale-closure bug on keyboard shortcuts                       (P0 / S)
     App.tsx:633-658 captures `schedule` once at mount via empty
     useEffect deps. Switch to a ref-based pattern OR re-register
     when handlers change.
```

### P1 — finish or fix before more features

```
[13] Drop /api request-line console.log usage                      (P1 / M)
     Replace remaining console.log calls inside route handlers
     with `req.log.info(...)`. Trace IDs only flow through pino,
     so plain console.log breaks the chain.

[14] Validate all POST/PUT bodies                                  (P1 / M)
     Add zod schemas in backend/src/api/validators/, validate at
     route entry, on failure throw a 400 with code='BAD_REQUEST'
     and the field path. The error handler already serialises
     it cleanly.

[15] requireEnv() coverage                                         (P1 / S)
     Extend requireEnv() to enforce SYSPRO_DB_SERVER,
     SCHEDULER_DB_NAME, SYSPRO_DB_NAME at startup. Today they
     silently default to "localhost"/"SYSPRO".

[16] Persist the read-only state keys                              (P1 / S)
     resourceDefinitions, shiftTemplates, alternativeGroups
     have no writers today. When mutators land, they must call
     appState.set(). Add a TODO + a thin wrapper helper
     `setLocal(req, key, value)` that does both.

[17] Fix N+1 in getJobMaterialPlans                                (P1 / M)
     Pre-fetch all WipJobAllocation rows once, group in JS,
     pass the pre-grouped Map into the per-job loop. 100-job
     batches drop from ~400 to ~3 round-trips.

[18] App.tsx — eliminate listener leaks + stale closures           (P1 / L)
     Beyond #11/#12, walk every useEffect with empty deps and
     decide if it's intentional. Add ESLint rule
     react-hooks/exhaustive-deps and fix every warning.

[19] Move undo/redo wiring into the components that mutate         (P1 / M)
     undoRedoManager exists but is unused. Push state on
     handleJobDrop, handleApproveOverride, scheduleAroundJob.
     Wire the toolbar Undo button to .undo()/.canUndo().

[20] React.memo on MachineGanttBoard + GanttTimeline split         (P1 / L)
     Wrap MachineGanttBoard in React.memo with a custom
     equality comparator on (scheduleId, brushRange,
     lockedOps). Then split into <GanttTimeline>,
     <OperationBar>, <DragOverlay>, <Legend>.

[21] Replace .slice(0, 120) hardcoded paginations                  (P1 / S)
     Today the job grid silently truncates. Either add proper
     pagination with a "Showing 120 of N — load more" footer,
     or virtualize with react-window.

[22] Sanitise CSV export                                           (P1 / S)
     bulkImportService.parseCSV doesn't handle escaped double
     quotes. Replace with papaparse (already in the artifact
     allowlist). Also use it for export so writes are robust.

[23] Memory-leak in exportService Blob URLs                        (P1 / S)
     Every export creates a Blob URL but never
     URL.revokeObjectURL(). Add cleanup after the download
     trigger fires.

[24] Wire bulk import into the UI                                  (P1 / M)
     bulkImportService.ts is fully implemented; the file inputs
     in App.tsx (`jobImportRef`/`opsImportRef`) are placeholders.
     Add the actual button + onChange handler in the Manage tab.
     Until this is in, the existing dead code wears
     eslint-disable comments and confuses readers.

[25] Schedule history table is referenced but not validated        (P1 / M)
     ScheduleVersionHistory renders, but reverting to a prior
     version doesn't actually re-run anything — it just swaps
     the in-memory schedule. Either remove the Restore button or
     have it call /api/schedule/:scheduleId/load.

[26] Backend test coverage — phase 1                               (P1 / L)
     Target SchedulingEngine and SysproDatabaseService:
       - jest mock for DbExecutor
       - test scheduleJob places a 30-minute op into 2-hour gap
       - test backward scheduling produces matching forward order
       - test overtime budget breach emits exactly one violation
       - test material shortage emits per shortage line, no dups
       - test exportSchedule rolls back when WipMaster fails
     Aim for ~25-30 tests, ~30-40% line coverage on services.

[27] Frontend test coverage — phase 1                              (P1 / M)
     React Testing Library smoke tests:
       - renders App with empty schedule, loads /api/jobs
       - BomDetailModal renders shortages, expand/collapse works
       - DarkModeContext flips data-theme attr
       - ErrorBoundary fallback renders on thrown error
     Aim for 12-15 tests.

[28] Add a tiny migration runner                                   (P1 / S)
     Walk backend/src/database/migrations/*.sql in order, track
     applied filenames in `sch_Migrations(filename, appliedAt)`,
     run unapplied ones inside a transaction at startup.
     Replace AppStateStore.ensureTable() with reading
     001_app_state.sql.

[29] Multi-stage backend Dockerfile                                (P1 / S)
     Two stages: builder (npm ci + tsc), runtime
     (node-alpine, copy dist + production node_modules only).
     Cuts image size and surface area materially.

[30] Frontend dev server proxy already done; document it in README (P1 / S)
     README still says "open http://localhost:3000". With the
     new dev split (3000 production, 3001 CRA dev), update the
     getting-started block. Also add a note about
     `npm run start:dev` for hot-reload + production-port.

[31] Remove the duplicate ConfigApp/ TCPEnabler/                   (P1 / S)
     Both modify Windows registry to enable SQL TCP/IP. Pick
     TCPEnabler/ (more polished), parameterise the instance
     name, delete ConfigApp/. Update start.cmd to use it.
```

### P2 — polish + UX

```
[32] Light-theme tokens                                            (P2 / S)
     theme.css defines :root[data-theme='light'] but a few
     values are inherited from dark; verify each token in the
     light block, fix anything that displays the dark default
     when the toggle is set to light.

[33] Resolve App.css duplicate selectors                           (P2 / M)
     `.aps-gantt-panel`, `.aps-grid-panel` defined 3-4 times
     each. Walk the file, dedup, group by component, push the
     CSS for each component into its own .css file alongside
     the .tsx.

[34] Replace remaining emoji on Constraint/Comparison/Pegging      (P2 / S)
     KpiDashboard already has lucide. Same treatment for
     ConstraintViolations (status pills), ScheduleComparison
     (change arrows), OrderPegging.

[35] Persist UI state to localStorage                              (P2 / S)
     workcentrePanelWidth, jobsPanelHeight, current main tab,
     job-search filter, color-mode pick. Already half-done in
     ganttPrefs; expand to cover panel layout.

[36] Highlight constraint violations on the Gantt                  (P2 / M)
     When the Constraints tab has a row, the corresponding op
     bar should pulse / outline in red on the Gantt. Click the
     row → scroll the Gantt to the bar.

[37] Multi-select drag                                             (P2 / L)
     Ctrl/Shift+Click to multi-select op bars; drag the group
     together. Power-user feature; common ask in any APS tool.

[38] Keyboard alternative for drag                                 (P2 / M)
     Arrow keys to nudge a selected operation by 1 day; Shift+
     Arrow by 1 hour. Essential for keyboard-only workflows
     and a11y.

[39] ARIA pass on the Gantt + modals                               (P2 / M)
     role="dialog" + aria-modal on every modal; focus-trap and
     focus-restore via small react helper. role="button",
     aria-expanded on tree toggles. Consider focus-visible
     ring tokens already in theme.css.

[40] Search persistence across tab switches                        (P2 / S)
     jobSearch resets when leaving "Production Jobs" and
     coming back. Move into a context or zustand store.

[41] Replace zustand placeholder with one real store               (P2 / M)
     Pick the smallest piece of App.tsx state (e.g. UI prefs
     - dark mode, panel sizes, search) and migrate it into a
     zustand store. This is the proof-of-concept that earns
     the bigger Refactor (#42).

[42] Split App.tsx — phased                                        (P2 / XL)
     Multi-week. Phases:
       a) Extract <Layout>, <Header>, <Ribbon>, <Footer>.
       b) Move scheduling state into useScheduleStore (zustand).
       c) Move UI state into useUiStore.
       d) Each tab becomes a route component.
       e) Drop the god component.
     Don't start until #41 has shipped and we know the pattern.

[43] Refactor MachineGanttBoard                                    (P2 / L)
     1000-line component; split as in #20. Likely needs to land
     after #20 + #41/#42 are stable.

[44] Real PDF export                                               (P2 / M)
     exportToPDF currently downloads HTML. Use jsPDF or
     pdf-lib (allow-list compatible) to produce a real PDF
     with the schedule summary + KPI table.

[45] Per-row badge for material shortages in the jobs grid        (P2 / S)
     Today shortages live only in the BOM modal. Add a small
     red dot beside the job ID for any job with shortageCount > 0
     in the latest material-plan run.

[46] Operation-level pin/lock from the jobs table                  (P2 / S)
     Lock state lives only in MachineGanttBoard.lockedOps.
     Surface a "Lock" column in the schedule table so a planner
     can pin without dragging.

[47] Onboarding banner when no SYSPRO connection                   (P2 / S)
     Today the UI loads with empty grids if the DB is
     unreachable. Show a top banner pointing to /health/ready
     and the connection profile.

[48] Document tooltip / discoverability for keyboard shortcuts     (P2 / S)
     Help icon → modal listing every shortcut. The
     keyboardShortcuts.ts manager already knows them; render
     its registry directly.

[49] Sequence-dependent setup time                                 (P2 / M)
     ConstraintManager has the matrix scaffolding but
     loadSetupSequences is a no-op. Wire it to a SYSPRO query
     against the setup-sequence table; use during slot search
     when the previous op on the same machine is for a different
     item.

[50] Skill matching enforcement                                    (P2 / S)
     SchedulingEngine.findBestOperationSlot:703-714 silently
     falls back to any Available resource when no skill match
     exists. Emit a Warning ConstraintViolation so the planner
     can see they're using an unqualified resource.

[51] Logger redaction expansion                                    (P2 / S)
     logger.ts redacts authorization, cookie, *.password.
     Add: any header/body field matching /token|secret|apiKey/i.

[52] Health-check on the frontend Docker container                 (P2 / S)
     Compose only health-checks the backend. Add a wget on the
     frontend nginx port.

[53] Add rate-limit middleware                                     (P2 / S)
     express-rate-limit on /api/schedule/* (the heaviest
     endpoint). 10 req/min per IP in production; bypass in dev.

[54] Audit-log table                                               (P2 / M)
     New sch_AuditLog (actorId, action, entityType, entityId,
     before, after, traceId, ts). Write rows on approve,
     export, override, drag-drop reschedule. Surface in a new
     History tab.

[55] Operation-status field on the bar                             (P2 / S)
     Bars only colour by lateness/critical-path/etc. Add a
     status overlay (Released / In Progress / Complete) read
     from WipJobAllLab.OperationStatus.
```

### P3 — strategic

```
[56] Authentication + RBAC                                         (P3 / L)
     Today every endpoint is anonymous. Pick a model:
     Windows-integrated (passport-windowsauth) for on-prem,
     OIDC for cloud. Two roles: Reviewer (read + draft),
     Approver (approve/export).

[57] Move off CRA to Vite                                          (P3 / L)
     CRA is unmaintained. Vite gives faster dev server,
     smaller bundles, easier lazy-loading per route. Required
     for #42 / #58 to make a real perf difference.

[58] Code-split by route                                           (P3 / M)
     After Vite. React.lazy each tab; the initial bundle drops
     from ~127 kB gz to <60 kB gz.

[59] OpenAPI spec + generated TS client                            (P3 / M)
     Hand-write spec at backend/openapi.yaml; openapi-typescript
     generates a typed client; replace services/api.ts.

[60] Replace ad-hoc DB migration with Umzug                        (P3 / S)
     #28 is a stopgap. Once there are 5+ migrations, switch
     to umzug + a proper migrations table.

[61] Pluggable optimisation engine                                 (P3 / XL)
     Today's algorithm is greedy. Add an interface around the
     engine; ship a reference greedy implementation and an
     optional CP-SAT (OR-Tools) backend that runs as a Python
     sidecar. Multi-objective scoring (tardiness, makespan,
     changeover) with user-tunable weights.

[62] Time-phased material check                                    (P3 / M)
     Currently every open PO counts. Adjust availability per
     job based on planned-start vs PO promise-date; subtract
     consumption from earlier-scheduled jobs.

[63] Real-time replan signals                                      (P3 / L)
     CDC or polling on WipMaster + WipJobAllLab; trigger
     incremental replan when jobs are released, completed,
     cancelled. SSE or WebSocket push to the UI.

[64] Scenario branching                                            (P3 / L)
     Beyond WhatIfPanel — name + clone a base schedule,
     side-by-side KPI comparison, "promote scenario to live".

[65] Mobile shop-floor view                                        (P3 / L)
     Read-only, mobile-first route showing today's schedule
     per workcentre with start/complete reporting back to
     SYSPRO labour.

[66] ADRs                                                          (P3 / S)
     /docs/adr/0001-cra-not-vite.md, 0002-no-orm.md, etc.
     Record the reasoning behind big decisions so future
     contributors don't relitigate them.

[67] Prune the redundant docs                                      (P3 / S)
     QUICK_START_GUIDE / FINAL_SUMMARY / FEATURE_IMPLEMENTATION
     overlap heavily. Keep one canonical user guide + the
     WEEKx logs + this REVIEW + ENHANCEMENT_PLAN; delete or
     fold the rest into the index.

[68] Performance budget + visual regression CI                     (P3 / M)
     Add bundle-size assertion (size-limit), Lighthouse CI on
     the homepage, and Playwright + Percy or Chromatic for
     screenshots of the Gantt under representative data.
```

---

## Suggested execution order

1. **Sprint 1 (1 week)** — ship the P0 list (#1–#12). All small. Unlocks CI and removes the worst data-integrity risks. After this every commit is verified.
2. **Sprint 2 (1-2 weeks)** — hit #13-#19 + #28 (logging, validation, undo wiring, migration runner). The result is a substantially safer platform.
3. **Sprint 3 (2 weeks)** — #26, #27, #29 (test coverage + Docker hardening). Now you can safely refactor.
4. **Sprint 4-5 (3-4 weeks)** — start the visible UX wins from P2: #34-#40, #45-#48. Bulk import wired (#24). Sequence setup (#49).
5. **Sprint 6+ (multi-week)** — the big architectural piece (#42 split App.tsx, #57 Vite, #43 Gantt split). Pick when team appetite is there.
6. **Strategic** — #56 auth, #61 pluggable engine, #62 time-phased material, #63 real-time replan. Scope individually.

## How to verify everything is converging

- `npm run lint` = 0 warnings, 0 errors.
- `npm test` = passes both suites in <30 s.
- `npm run build` = builds on Linux and Windows.
- `npm start` = boxed banner appears, http://localhost:3000/ serves the dark APS UI within ~50 ms of process start, both DBs connect within ~3 s.
- `/health/ready` returns 200 once both DBs connect, 503 otherwise.
- A fresh `npm install` + `npm start` against a freshly-applied SCHEDULER DB works end-to-end without any manual intervention beyond a populated `backend/.env`.
- Playwright (P3 #68) records the Gantt rendering, the BOM modal opening, schedule generation completing.

---

*End of review.*
