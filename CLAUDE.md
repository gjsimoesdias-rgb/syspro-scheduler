# SchedulerNEW_01042026 — project notes

SYSPRO-integrated APS scheduler. React + Vite + TypeScript frontend, Node backend.

## UI / theming conventions (established July 2026)
- Design tokens live in `frontend/src/styles/theme.css`. Dark is default; light/dark flip
  via `data-theme` on `<html>` (set in `stores/uiStore.ts`, which also toggles a legacy
  `.dark-mode` class). Tokens: `--bg-*`, `--text-*`, `--border-*`, `--accent*`, `--status-*`,
  plus legacy aliases (`--bg-primary/secondary/card`, `--border`, `--border-color`).
- `frontend/src/styles/aps-overrides.css` is the intended override layer (loaded AFTER
  App.css). Put refinements here using tokens; avoid new hardcoded hex.
- Prefer tokens over hardcoded colors so both themes adapt automatically. Do NOT add new
  `:root.dark-mode` patch rules — that dual system is being retired.
- Single brand accent is blue (`--accent` #4f8bff dark / #2563eb light). The old purple
  `#667eea` was fully removed — don't reintroduce it.
- Build runs on Windows via `START_SCHEDULER.cmd` (step 3 = `npm run build:frontend`).
  Vite 8's native binary is Windows-only, so `vite build` can't run in the Linux sandbox;
  verify changes with `npx tsc --noEmit` instead.

## Removed (July 2026) — do not resurrect as "broken"
- Dead components deleted: AnalyzeDashboard, BottleneckAnalyzer, GanttChart, OrderPegging,
  ResourceAllocation (superseded by BottleneckAnalysis, DraggableGantt/MachineGanttBoard,
  PeggingView, ResourceLeveling).
- Removed non-functional UI: Settings "coming soon" tabs (Job Import, MRP Rules,
  Integration) and the "Document management not yet connected to SYSPRO DMS" context action.

## APS feature set added (July 2026)
- **Changeover matrix** (`dbo.sch_SetupMatrix`, migration 003) now actually loads in
  `/api/schedule/generate` (previously read the wrong table `aps.SetupMatrix` and was
  always empty) and is workcentre-aware (`wc|from->to` keys beat generic `from->to`).
  CRUD: `GET/POST /api/schedule/setup-matrix`, `DELETE /api/schedule/setup-matrix/:id`.
  UI: "Changeovers" content tab (`SetupMatrixEditor.tsx`).
- **Frozen zone / firm time fence**: `freezeHorizonDays` in the generate request
  auto-pins ops from the latest saved schedule starting inside the fence (manual pins
  win). UI field in ScheduleSetupModal.
- **Dispatch lists**: "Dispatch" content tab (`DispatchListView.tsx`), printable
  per-machine work-to lists built client-side from the schedule.
- **CTP order promising**: `POST /api/schedule/ctp` + `CtpService.ts` (calendar- and
  load-aware earliest-finish placement; pure function, unit-tested). UI: "Promise" tab
  (`OrderPromisePanel.tsx`). Calendar logic MUST mirror
  `SchedulingEngine.getProductiveWindowsForDay` (schedulable diversions only, Mon–Fri
  08:00–16:00 defaults). Master/sub families: `subJobs` legs run in parallel sharing
  capacity; the master routing starts after the last sub finishes; promise = master end.
  Stock-code quoting: `GET /api/schedule/ctp/stock-search` + `GET
  /api/schedule/ctp/stock-routing/:stockCode?quantity=n` build the CTP request from
  SYSPRO BomOperations (first route; hours→minutes ×60; unit run × qty) and made-in
  BomStructure components (depth 1) as sub-legs — NOT from open WIP jobs.
- **Job click → Gantt focus**: `handleJobRowClick` highlights the job, switches to the
  Gantt tab and passes ALL its workcentres via `ganttFocusWorkcentre`
  (`string | string[] | null`); MachineGanttBoard shows those lanes and scrolls to the
  job's earliest op bar.
- Route-order rule for `schedule.ts`: static GET paths (`/latest`, `/pins`,
  `/setup-matrix`) MUST be registered before `GET /:scheduleId` or they get shadowed
  (this bug previously broke `GET /pins`).
- Backend jest suites do not run in the Linux sandbox (Windows-installed node_modules
  → jest-environment version clash). Run `npm test` on Windows; typecheck with
  `npx tsc --noEmit` in the sandbox instead.

## Plan lifecycle, companies and security (October 2026)
- **No approval step** (owner's decision, 2026-10-02): Send to SYSPRO = save the board as
  master + export. Export only accepts the master (`IsLatest=1`, not a what-if), one per
  company at a time, audit-logged. Don't reintroduce `/approve`.
- **Master revision**: `SavedSchedules.Revision`; `/schedule/save` takes `baseRevision` and
  returns 409 `MASTER_CHANGED` on a stale board. Frontend tracks it in `services/api.ts`
  (`masterRevision`, saves serialised). Server-side runs (Generate) don't send a base.
- **Per-company state**: plan tables live in SCHEDULER DB schema `co_<CompanyDb>`
  (`planStore.ts`); `sch_AppState` keys are `co:<CompanyDb>|<key>` and reload on every
  `/connect` (`services/companyState.ts`). New per-company keys go in `APP_STATE_KEYS`.
- **Company settings** for users without a company (super_admin, NTLM, Auto plan) come from
  `api/companyContext.ts` (`lic_companies.syspro_company_id` = connected DB, or the only
  company). Use `companyFor(req)`, never `req.user.companyId` directly.
- **Job flags** (Exclude / Pin job) are server-side (`/api/jobs/flags`, `utils/jobFlags.ts`).
- **Machine qualification**: the engine treats `{ScheduledMachine, IMachine}` as an op's
  allowed machines. Keep it: on HFARM routings have blank IMachine and ScheduledMachine is
  what keeps ops on the right machine. Export writes ScheduledMachine only (never IMachine).
- **Calendars**: day windows come from `utils/shiftWindows.ts` (night-shift tails belong to
  the previous day). Engine and CTP both call it — don't fork the logic again.
- **Shop floor** needs `X-Shopfloor-Key` (`SHOPFLOOR_KEY` in backend/.env) or a login; CORS is
  off unless `CORS_ORIGINS` is set. `START_SCHEDULER.cmd` runs `NODE_ENV=production`.
- **UI**: use `confirmDialog` / `promptDialog` / `alertDialog` (`components/DialogHost.tsx`),
  never `window.confirm/prompt/alert`. Use `apiJson` / `apiClient`, not raw `fetch`.
- **Line endings are mixed** (some files CRLF, most LF). Keep each file's style: edit with
  tools that preserve it (Python on Windows writes CRLF in text mode — use `newline=''`).
