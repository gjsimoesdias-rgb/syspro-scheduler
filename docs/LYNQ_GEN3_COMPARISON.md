# LYNQ Gen 3 APS vs our SYSPRO Scheduler

**Date:** 2026-09-29 · **Source:** read-only walk-through of `au.app.lynqmes.cloud` (Tenant 999 demo data), plus our code.

**Coverage:** two sessions on 29–30 Sep. Everything below was opened except *Versions → Manage* (stuck loading) and drag/lock on the planning board: the demo board has no bars in the visible weeks, and moving bars would change the plan.

**Nothing was changed in LYNQ:** no save, schedule, publish or recalculate. The CTP form was opened, left blank and not saved.

**Bottom line:** our app already covers most of LYNQ's *scheduling logic*: changeovers, frozen zone, CTP, material checks, master/sub precedence and pins. Where LYNQ is clearly ahead:

1. **Resources beyond the machine.** Tools/fixtures and employees are finite resources, and alternatives are chosen by **capability attributes**.
2. **Richer operation timing.** Cycle setup, wait, teardown, outside (subcontract) time, transfer/overlap, split and parallelism.
3. **A real plan lifecycle.** Master + what-if versions with compare/commit/revert, time-fence locks, per-order publish status, background (scheduled) autoschedule.
4. **Planner-first layout.** Resource tree → order grid → planning board on one screen, with far fewer tabs than ours.

---

## 1. LYNQ Gen 3 feature inventory (as found)

### Visual APS screen

| Area | What it does |
|---|---|
| **Resource tree** (left) | Division → WorkCenter → work units. Toggles show/hide work units, **secondary constraints (tools)** and **employees**. Views: tree, list by name, list by sort index, organisational structure. The ticked resources are exactly the lanes shown on the board. |
| **Order grids** (top, dockable tabs) | **Job Orders**, **Suggested** (MRP-suggested jobs) and **CTP**. Each has a single-level or hierarchy view. |
| Order grid columns | FMAD (availability from stock, supply, demand and lead time), scheduled flag, **locked**, **overdue**, **deadline**, **valid for scheduling**, material availability, **global** material availability, **marker** (e.g. Priority-High colour), dependents count, **setup class**, planned/actual qty, APS start/end, ERP required start/end, division, **MES publish status** (pending/published/error) and **publish action** (scheduled/unscheduled). |
| Order grid actions | Autoschedule selected (up to 10 000), recalc materials for the page, run material calc per order, Excel export, column filters, group-by. |
| **Planning board** (bottom) | Zoom slider, period ahead/behind, interval picker, shift bar, direction (fwd/bwd). Toggles for: schedule-around, split, autoload alternatives, same-resource rescheduling, same setup/consumption rescheduling, use setup. |

### Menus

| Menu | Items |
|---|---|
| Dashboards | Capacity Analysis · Inventory Analysis · Workunit Analysis · Employee Analysis |
| Schedule | Autoschedule (Background) · Capable To Promise · Production Plan (Live) · **Publish / Unpublish Plan (Master)** |
| Time Period | Planning Period · **Time Fence Lock / Unlock** · Remove All Locks (Version) |
| Versions | Manage · **Compare** · **Revert to Master** · **Commit to Master** (Master + Plan A/B/C) |
| Settings | Planner Preferences · Scheduling Defaults (Global) · MRP Settings · Recalculate Materials · **Planner Roles** · **Markers** · Reset Layout |
| Master data — Orders | Job · CTP · Purchase · **Suggested Purchase** · **Sales** · **Forecast** · **Transfer** |
| Master data — Product | Products · Categories · Product Structures (with revision + warehouse) · UOM |
| Master data — Inventory | Warehouse · Inventory · Bin/Serial/Lot |
| Master data — Resource | Divisions · Work Units (type: work unit / **tool**) · Employees · Resource Units (licensed) · Production Lines · Hierarchies · **Resource↔Attributes (capabilities)** · **Resource↔Product (per-product setup/run/cycle/wait/teardown times)** · **Setup/Changeover Matrix** · Licensing |
| Master data — Capacity | **Activities** (uptime/downtime, direct/indirect, efficiency multiplier) · **Calendars** (incl. per-person) · **Week Shifts** (with paid breaks/unpaid lunch) · **Exceptions** (sick/vacation, full/half day, short day) |
| Configuration | General (decimals, Gantt record limit, sandbox, maintenance mode, KPI, languages) · Integrations (licensed instances) · Processes (background jobs) · Health Check download |
| Other | AI assistant, "Create calendar with AI", walk-through tours, per-user layout reset |

### Scheduling rules

These come from Planner Preferences → Schedule, and Scheduling Defaults (Global).

- **Method and window:** forward/backward, processing batch size, schedule from/to (interval), current-time offset.
- **Resources:**
  - Autoload default + alternative resources **by attribute**.
  - Alternative batch size/attempts.
  - Float resources (min/max threshold).
  - Same-resource / same-setup / same-consumption on reschedule.
- **Time elements, each switchable:** operation setup and **cycle setup**, setup matrix *as per resource*, apply setup **once per group**, wait, teardown, move, queue, **transfer**, **parallelism**, **outside time** (operation / cycle).
- **Non-working time:** move, queue, wait and teardown can run in non-working time ("autoschedule as next day").
- **Setup edge cases:** skip setup if quantity already reported; apply setup when no run quantity.
- **Hierarchy:** full parent/child hierarchy, dependency between groups, reschedule already scheduled.
- **Split:** min & max segment.
- **Schedule-around:** full strategy, include related orders.
- **Autoshift** (push later ops), limit capacity activities, period policy.
- **Background schedule:** cron-like jobs per scheduling version, with status/history.
- **Maintenance:**
  - Purge orphan/historical scheduling data and audit older than N days.
  - Reset versions, locks or planner settings.
  - Record counters per version/year.

Demo data points worth copying:

- The changeover matrix is **per resource, from setup class → to setup class, in hours + minutes**. For example, `Allergen-Fruit-Caffeine → Allergen-Fruit-Apple` = 10 h on the Advanced Blender, and same→same = 5 min.
- Setup class is a field on the job order.

### Dashboards, versions and CTP (second session)

| Screen | What it shows |
|---|---|
| **Capacity analysis** | Load % per work centre per week, as a chart plus a table. Filters: date range, *include* Job / Suggested / CTP orders (All/None), hour type (run hours), **split by due date**, bucket (weekly). Expand by resource or by metric. Excel export. |
| **Work unit plan** (and the employee equivalent) | Day / week / month; capacity, card and list views; **Analyse with AI**. An hours summary per resource uses a time model (below), plus a daily plan table with planned quantity. |
| **Inventory analysis** | **Projected stock per product × warehouse per day (or week)** for N periods, so you can see when a component runs out. |
| **Version comparison** | One column per version; the KPI set is below. Also has *Analyse with AI*. |
| **Production plan (Live)** | The same plan as **Gantt / List / Board / Print** views, filtered by resource (51). |
| **New CTP request** | Product + product structure, qty + UOM, division, receipt warehouse. Flags: create sub-orders, require material planning, scheduling method (fwd/bwd), required start/end, **reserve capacity** (or not). Customer, order type, order and line, priority, source ID, originator/email, **expiry date**, notes. Saved with **Save & schedule**. |

**LYNQ's time model**, verbatim from its tooltips. This is the fix for our broken "utilization" metric (review §3.5-2):

| Measure | Definition | % is of |
|---|---|---|
| Calendar | all hours in the period | — |
| Operating | shift / working time | calendar |
| Busy | planned production + setup | operating |
| Productive | planned run time, excluding setup/changeover | operating |
| Downtime (direct) | setup/changeover and other job-related unproductive time | operating |
| Downtime (indirect) | idle + maintenance, not tied to a job | operating |
| Idle / Maintenance | split of indirect downtime | operating |

**Version comparison KPIs:**

- Period and resource units.
- The time model above, in hours and %.
- Loading effectiveness % and planned quantity complete.
- For each of Job, Suggested and CTP orders: count, scheduled count, **scheduled-late count**, **average late days**, **OTD rate**.
- **Average lead time (days)**.

---

## 2. Side-by-side

| Capability | LYNQ Gen 3 | Ours today | Gap |
|---|---|---|---|
| Finite machines/lines | ✔ | ✔ (workcentre capacity = 1) | — |
| **Tools / secondary constraints** | ✔ (work unit type *Tool*) | ✘ | **High** |
| **Labour / employees as capacity** | ✔ (employees, per-person calendars, exceptions) | ✘ | **High** |
| **Alternatives by capability attribute** | ✔ | Manual alternative groups | Medium |
| Per-product run/setup times on a resource | ✔ Resource↔Product | Uses SYSPRO routing only | Medium |
| Sequence-dependent changeover | ✔ per resource, setup class | ✔ item + ProductClass, workcentre-aware | Low: add per-resource scope and a configurable "setup class" source |
| Setup once per group / campaign | ✔ | ✘ | Medium |
| Wait, teardown, cycle times | ✔ | ✘ (setup + run + queue + move only) | Medium |
| **Outside / subcontract time** | ✔ | ✘ (subcontract ops take machine capacity) | **High for SYSPRO**: WIP subcontract operations are common |
| Transfer / overlap, split, parallelism | ✔ | ✘ | Medium |
| Holidays / exceptions / breaks | ✔ | Diversions only, **holidays ignored** | High (already in phase 3) |
| Shift efficiency multiplier | ✔ (activities) | ✘ | Low |
| Forward / backward | ✔ | ✔ | — |
| Schedule-around / autoshift on manual moves | ✔ | Dependency guards only | Medium |
| **Locks + time fence (lock/unlock by period)** | ✔ persisted per version | Frozen zone (generate-time) + pins in memory | Medium: persist, add unlock/remove-all |
| **Versions: master + what-if, compare, commit, revert** | ✔ | Scenarios (broken until phase 2) + version history | **High** (merge into one model) |
| CTP | ✔ separate CTP orders grid | ✔ Promise tab | Low: persist CTP quotes as orders |
| **Suggested (MRP) orders scheduling** | ✔ | ✘ (open WIP jobs only) | **High**: capacity-check SYSPRO MRP suggestions before release |
| Sales / forecast / transfer orders | ✔ | ✘ | Medium: sales-order pegging drives due dates |
| Material availability per order + global | ✔ FMAD + global | ✔ per job (column bugs in review §3.6) | Fix first (phase 3) |
| **Publish status per order** (pending/published/error, scheduled/unscheduled) | ✔ | All-or-nothing export, now status on schedule only | **High** (also fixes export idempotency) |
| Background (scheduled) autoschedule | ✔ | ✘ (`SCHEDULE_INTERVAL` env exists, unused) | Medium |
| Multi-planner roles / resource ownership | ✔ | ✘ | Low |
| Divisions | ✔ | ✘ (single company DB) | Low |
| Markers (colour tags on orders) | ✔ | Priority only | Low |
| Dashboards: capacity (load % by week, split by due date), **projected inventory by day**, work-unit/employee time model | ✔ | KPI, capacity histogram, bottleneck, inventory (current stock only) | Medium: adopt the time model + projected inventory |
| KPI set for comparing plans (OTD %, late count, avg late days, lead time, busy/productive/downtime %) | ✔ | `calculateMetrics` (utilization metric is wrong) | **High**: needed for versions compare *and* the optimizer |
| CTP: reserve capacity, expiry date, customer/order refs, save & schedule | ✔ | Quote only, not saved | Medium |
| Rule optimizer (compare dispatch rules) | Not seen | ✔ | **We're ahead** |
| Dispatch / work-to lists | Not in APS (MES side) | ✔ | We're ahead |
| Data purge / maintenance page | ✔ | ✘ | Medium (matches review §6.5 retention) |
| Excel export on every grid | ✔ | CSV/JSON/PDF of schedule only | Low |

---

## 3. What this changes in the plan

Phases 0–1 are done. The table below is the updated roadmap. It replaces §8 of `REVIEW_2026-09-29.md`.

| Phase | Items | Changed? |
|---|---|---|
| **2 — Broken features** | As before: API base URL, Scenarios auth, 401 refresh, SSE, `constraintViolations`, transactional saves | Unchanged |
| **3 — Correct numbers** | As before (utilization now uses LYNQ's time model: operating / busy / productive / direct & indirect downtime / idle; KPIs add OTD %, late count, avg late days, lead time), plus **calendar exceptions** (holidays, full/half-day absences, short days) instead of only holidays, and **subcontract/outside operations** as elapsed time that consumes no machine capacity | Extended |
| **4 — Scale** | As before (set-based loaders, slot-search indexing, Gantt virtualization). LYNQ caps autoschedule at 10 000 items and has a Gantt record limit. Adopt the same guardrails, shown in the UI | Extended |
| **5 — Plan lifecycle** (was "Structure") | Move schedules to the SCHEDULER DB **as a versions model**: one **Master** + what-if versions, **Compare / Commit to Master / Revert**. This replaces both Scenarios and Version History. Persist **locks** per version (op lock, time-fence lock/unlock, remove all). **Per-job publish status** (pending/published/error + scheduled/unscheduled) with **incremental publish/unpublish** to SYSPRO, which also makes export idempotent. Retention/purge page | **Re-scoped** |
| **6 — UX** | Adopt LYNQ's proven layout: **resource tree (left, ticks = lanes) → order grid (top: Jobs / Suggested / CTP) → planning board (bottom)**, one menu: *Plan · Master data · Settings*. Collapses our 24 content tabs to ~6. Order grid gets *valid for scheduling*, *locked*, *overdue*, *deadline*, *material* and *publish* status columns. Excel export on grids | **Re-scoped** |
| **7 — APS depth** (new) | In priority order: (1) **tools/secondary constraints**; (2) **labour** with per-person calendars and exceptions; (3) **alternatives by capability attribute**; (4) **MRP suggested jobs** scheduled before release; (5) wait/teardown/cycle times, setup once per group; (6) transfer/overlap and split; (7) background autoschedule jobs; (8) sales-order pegging for due dates; (9) projected-inventory dashboard (per product × warehouse per day); (10) CTP quotes saved as orders with reserve-capacity and expiry | **New** |

We keep what LYNQ doesn't have: the rule optimizer, dispatch lists, master/sub-job precedence from `WipMasterSub`, and direct SYSPRO reads without a sync layer.

## 4. SYSPRO data sources for the new items

To verify on your install with a quick column check before building.

| Feature | Likely SYSPRO source |
|---|---|
| Subcontract ops | `WipJobAllLab` subcontract flag / supplier fields; `BomOperations` subcontract |
| Tools | `BomOperations`/`WipJobAllLab` tool set fields, or a scheduler-side table if not used |
| Labour | Employee/work-centre links (`BomWorkCentre` labour rates), or a scheduler-side crew table |
| MRP suggested jobs | MRP suggested-job tables (e.g. `MrpSugJobMaster`) |
| Sales-order pegging | `SorMaster` / `SorDetail` + `WipMaster` sales-order links |
| Setup class | `InvMaster.ProductClass` (used today) or a user-defined field — make it configurable |
