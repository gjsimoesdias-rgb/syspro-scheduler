# Production Modes

The scheduler supports three production modes that control how job operations
are assigned to resources.  The mode is set per schedule run via the
`productionMode` field in the API request body or the Production Mode selector
in the Setup modal.

---

## Modes

### Job Shop (default)

```
productionMode: "job-shop"
```

Each operation is assigned independently to the best available resource.
Operations belonging to the same job may run on resources in different line
groups.  This is the classical job-shop behaviour and is the default.

### Continuous Line (flow-line)

```
productionMode: "flow-line"
```

All operations of a job are locked to the **same production line**.  When the
first operation of a job is placed on a resource that belongs to line group
`"Line-A"`, every subsequent operation of that job is also restricted to
resources in `"Line-A"`.

If no resource in the locked line group is qualified for a downstream
operation, the engine emits a `LineGroupViolation` warning and falls back to
the global resource pool for that operation.  The job is still scheduled; the
violation is informational.

**When to use:** Dedicated assembly or process lines where moving a job between
lines mid-production is operationally impractical.

### Mixed

```
productionMode: "mixed"
```

The system default is job-shop, but individual jobs can opt into flow-line
behaviour by setting `productionMode: "flow-line"` on the job itself.  Jobs
that do not have a per-job mode set are scheduled in job-shop mode.

**When to use:** Facilities that have both shared workcell areas and dedicated
lines coexisting in the same schedule.

---

## Resource Line Groups

Assign a resource to a line group by setting `lineGroupId` in the Resource
Definitions tab.  Any non-empty string can be a line group identifier (e.g.
`"Line-A"`, `"Cell-2"`, `"Press-Line"`).

Resources without a `lineGroupId` are **never** filtered out by the line-group
constraint — they are always available to any job regardless of the production
mode.  This lets shared support resources (e.g. a single quality-inspection
station) remain freely accessible.

---

## API Reference

`POST /api/schedule/generate`

| Field | Type | Default | Description |
|---|---|---|---|
| `productionMode` | `"job-shop" \| "flow-line" \| "mixed"` | `"job-shop"` | System-wide scheduling mode |
| `lineGroupOverrides` | `Record<string, string>` | — | Per-job overrides in mixed mode (`jobId → lineGroupId`) |

---

## Constraint Violations

| Type | Severity | When emitted |
|---|---|---|
| `LineGroupViolation` | Warning | An operation had no qualified resource in the locked line group; the engine fell back to the global pool |

---

## CP-SAT Engine

The CP-SAT sidecar also honours line-group constraints.  When a job is in
flow-line mode, the Python solver filters each operation's qualified resource
list to resources that share the same `line_group_id`.  If no such resource
exists the constraint is silently relaxed (same graceful-fallback behaviour as
the greedy engine).
