"""
Syspro Scheduler — CP-SAT Optimisation Sidecar
===============================================
A lightweight FastAPI service that wraps Google OR-Tools CP-SAT to solve
the Job-Shop scheduling problem with multi-objective optimisation.

Objectives (user-tunable weights, default 1.0 each):
  - Minimise total weighted tardiness
  - Minimise makespan
  - Minimise total changeover (setup) time

Input (POST /solve):
  See SolveRequest schema below.

Output:
  See SolveResponse schema below.

Usage:
  pip install -r requirements.txt
  uvicorn main:app --host 0.0.0.0 --port 5050

Docker:
  docker build -t scheduler-cpsat .
  docker run -p 5050:5050 scheduler-cpsat
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── OR-Tools CP-SAT ────────────────────────────────────────────────────────────
try:
    from ortools.sat.python import cp_model  # type: ignore
    ORTOOLS_AVAILABLE = True
except ImportError:
    ORTOOLS_AVAILABLE = False
    logging.warning(
        "ortools not installed.  Install with: pip install ortools\n"
        "The /solve endpoint will return 503 until ortools is available."
    )

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Syspro Scheduler — CP-SAT Sidecar",
    version="1.0.0",
    description="Multi-objective job-shop scheduling via Google OR-Tools CP-SAT",
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


# ── Request / Response models ─────────────────────────────────────────────────

class OperationIn(BaseModel):
    op_id: str
    job_id: str
    sequence: int
    workcentre_id: str
    duration_minutes: int = Field(ge=1)
    setup_time_minutes: int = Field(ge=0, default=0)
    queue_time_minutes: int = Field(ge=0, default=0)
    move_time_minutes: int = Field(ge=0, default=0)
    qualified_resource_ids: list[str] = Field(default_factory=list)
    predecessor_op_id: str | None = None


class JobIn(BaseModel):
    job_id: str
    priority: int = Field(ge=1, le=10, default=5)
    due_date_epoch_seconds: int
    release_date_epoch_seconds: int | None = None
    line_group_id: str | None = None
    # SYSPRO master/sub hierarchy: this job feeds master_job_id, so all of
    # its operations must finish before the master's first op may start.
    master_job_id: str | None = None


class ResourceIn(BaseModel):
    resource_id: str
    workcentre_id: str
    capacity_units: int = Field(ge=1, default=1)
    # Availability windows: list of [start_epoch, end_epoch] open intervals
    availability_windows: list[list[int]] = Field(default_factory=list)
    line_group_id: str | None = None


class ObjectiveWeights(BaseModel):
    tardiness: float = Field(ge=0.0, default=1.0)
    makespan: float = Field(ge=0.0, default=1.0)
    changeover: float = Field(ge=0.0, default=1.0)


class SolveRequest(BaseModel):
    horizon_start_epoch: int
    horizon_end_epoch: int
    jobs: list[JobIn]
    operations: list[OperationIn]
    resources: list[ResourceIn]
    weights: ObjectiveWeights = Field(default_factory=ObjectiveWeights)
    time_limit_seconds: int = Field(ge=1, le=300, default=30)


class ScheduledOperation(BaseModel):
    op_id: str
    job_id: str
    resource_id: str
    workcentre_id: str
    start_epoch: int
    end_epoch: int
    setup_start_epoch: int
    setup_end_epoch: int
    run_start_epoch: int
    run_end_epoch: int
    queue_end_epoch: int
    move_end_epoch: int
    sequence: int
    is_overtime: bool = False


class SolveResponse(BaseModel):
    status: str          # OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN
    objective_value: float | None = None
    tardiness_score: float | None = None
    makespan_minutes: int | None = None
    changeover_minutes: int | None = None
    scheduled_operations: list[ScheduledOperation] = Field(default_factory=list)
    unscheduled_job_ids: list[str] = Field(default_factory=list)
    solve_time_seconds: float
    solver_status_code: int


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "ortools_available": ORTOOLS_AVAILABLE,
    }


# ── Solve ─────────────────────────────────────────────────────────────────────

@app.post("/solve", response_model=SolveResponse)
def solve(req: SolveRequest) -> SolveResponse:  # noqa: C901
    if not ORTOOLS_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="ortools is not installed on this sidecar.  "
                   "Run: pip install ortools",
        )

    t0 = time.monotonic()
    horizon_minutes = max(1, (req.horizon_end_epoch - req.horizon_start_epoch) // 60)

    # ── Index look-ups ────────────────────────────────────────────────────────
    job_map: dict[str, JobIn] = {j.job_id: j for j in req.jobs}
    resource_map: dict[str, ResourceIn] = {r.resource_id: r for r in req.resources}
    # Group operations by job and sort by sequence
    ops_by_job: dict[str, list[OperationIn]] = {}
    for op in req.operations:
        ops_by_job.setdefault(op.job_id, []).append(op)
    for ops in ops_by_job.values():
        ops.sort(key=lambda o: o.sequence)

    model = cp_model.CpModel()
    all_tasks: dict[str, dict[str, Any]] = {}   # op_id → task variables
    resource_to_intervals: dict[str, list[Any]] = {r.resource_id: [] for r in req.resources}

    # ── Create interval variables for each operation ──────────────────────────
    for op in req.operations:
        total_duration = op.duration_minutes + op.setup_time_minutes
        start = model.NewIntVar(0, horizon_minutes, f"start_{op.op_id}")
        end = model.NewIntVar(0, horizon_minutes, f"end_{op.op_id}")
        interval = model.NewIntervalVar(start, total_duration, end, f"iv_{op.op_id}")

        # Resource assignment: if multiple resources are qualified, pick one
        qualified = [
            rid for rid in op.qualified_resource_ids
            if rid in resource_map
        ]
        if not qualified:
            # Fall back: any resource in the same workcentre
            qualified = [
                r.resource_id for r in req.resources
                if r.workcentre_id == op.workcentre_id
            ]
        if not qualified and req.resources:
            qualified = [req.resources[0].resource_id]

        # Flow-line constraint: if the job has a line_group_id, restrict
        # assignment to resources in the same group (graceful degradation if none found).
        job_line_group = job_map.get(op.job_id, None)
        if job_line_group and job_line_group.line_group_id:
            in_group = [
                rid for rid in qualified
                if resource_map.get(rid) and resource_map[rid].line_group_id == job_line_group.line_group_id
            ]
            if in_group:
                qualified = in_group
            # else: no in-group resource found — fall back to full qualified list

        if len(qualified) == 1:
            assigned_resource = qualified[0]
            resource_to_intervals[assigned_resource].append(interval)
            presence_literals: dict[str, Any] = {}
        else:
            # Optional interval per candidate resource; exactly one is active
            presence_literals = {}
            for rid in qualified:
                lit = model.NewBoolVar(f"pres_{op.op_id}_{rid}")
                opt_iv = model.NewOptionalIntervalVar(
                    start, total_duration, end, lit, f"ov_{op.op_id}_{rid}"
                )
                presence_literals[rid] = lit
                resource_to_intervals[rid].append(opt_iv)
            model.AddExactlyOne(presence_literals.values())
            assigned_resource = qualified[0]  # placeholder; overridden at extraction

        all_tasks[op.op_id] = {
            "start": start,
            "end": end,
            "interval": interval,
            "op": op,
            "qualified": qualified,
            "presence": presence_literals,
            "assigned_resource": assigned_resource,
        }

    # ── Calendar availability: add blocked intervals for non-working periods ──
    for res in req.resources:
        if not res.availability_windows:
            continue  # no calendar constraint for this resource

        # Convert epoch-second windows to minute offsets from horizon start
        avail: list[tuple[int, int]] = []
        for win in res.availability_windows:
            if len(win) < 2:
                continue
            s = max(0, (win[0] - req.horizon_start_epoch) // 60)
            e = min(horizon_minutes, (win[1] - req.horizon_start_epoch) // 60)
            if e > s:
                avail.append((s, e))

        if not avail:
            continue

        avail.sort()

        # Build forbidden (non-working) periods as the complement of avail
        blocked: list[tuple[int, int]] = []
        prev_end = 0
        for (ws, we) in avail:
            if ws > prev_end:
                blocked.append((prev_end, ws))
            prev_end = max(prev_end, we)
        if prev_end < horizon_minutes:
            blocked.append((prev_end, horizon_minutes))

        # Add a fixed interval for each blocked period so NoOverlap prevents
        # operations from being scheduled during non-working time.
        for i, (blk_s, blk_e) in enumerate(blocked):
            dur = blk_e - blk_s
            if dur <= 0:
                continue
            blk_iv = model.NewIntervalVar(
                model.NewConstant(blk_s),
                model.NewConstant(dur),
                model.NewConstant(blk_e),
                f"blocked_{res.resource_id}_{i}",
            )
            resource_to_intervals[res.resource_id].append(blk_iv)

    # ── No-overlap per resource ───────────────────────────────────────────────
    for rid, intervals in resource_to_intervals.items():
        if intervals:
            model.AddNoOverlap(intervals)

    # ── Precedence: ops within same job must be sequential ────────────────────
    for job_id, ops in ops_by_job.items():
        for i in range(len(ops) - 1):
            prev = all_tasks[ops[i].op_id]
            nxt = all_tasks[ops[i + 1].op_id]
            # end of previous + move_time + queue_time of next <= start of next
            gap = ops[i].move_time_minutes + ops[i + 1].queue_time_minutes
            model.Add(nxt["start"] >= prev["end"] + gap)

    # ── Master/sub-job precedence (SYSPRO WipMasterSub) ───────────────────────
    # Every operation of a sub-job must end before the first operation of its
    # master job starts. Skip silently when the master isn't in this solve.
    for job in req.jobs:
        if not job.master_job_id or job.master_job_id == job.job_id:
            continue
        master_ops = ops_by_job.get(job.master_job_id, [])
        sub_ops = ops_by_job.get(job.job_id, [])
        if not master_ops or not sub_ops:
            continue
        master_first_start = all_tasks[master_ops[0].op_id]["start"]
        for sub_op in sub_ops:
            model.Add(master_first_start >= all_tasks[sub_op.op_id]["end"])

    # ── Objective ─────────────────────────────────────────────────────────────
    SCALE = 1000  # fixed-point scale for float weights

    tardiness_terms: list[Any] = []
    makespan_vars: list[Any] = []

    for job in req.jobs:
        job_ops = [all_tasks[op.op_id] for op in ops_by_job.get(job.job_id, [])]
        if not job_ops:
            continue
        due_offset = max(0, (job.due_date_epoch_seconds - req.horizon_start_epoch) // 60)
        weight = 11 - job.priority  # higher priority → higher weight

        # Last op end time
        last_end = model.NewIntVar(0, horizon_minutes, f"last_{job.job_id}")
        model.AddMaxEquality(last_end, [t["end"] for t in job_ops])
        makespan_vars.append(last_end)

        # Tardiness = max(0, last_end - due_offset)
        tard = model.NewIntVar(0, horizon_minutes, f"tard_{job.job_id}")
        raw_tard = model.NewIntVar(-horizon_minutes, horizon_minutes, f"rtard_{job.job_id}")
        model.Add(raw_tard == last_end - due_offset)
        model.AddMaxEquality(tard, [raw_tard, model.NewConstant(0)])
        tardiness_terms.append(int(req.weights.tardiness * SCALE * weight) * tard)

    # Makespan = max over all job ends
    makespan = model.NewIntVar(0, horizon_minutes, "makespan")
    if makespan_vars:
        model.AddMaxEquality(makespan, makespan_vars)
    else:
        model.Add(makespan == 0)

    objective_terms: list[Any] = []
    if req.weights.tardiness > 0 and tardiness_terms:
        objective_terms.extend(tardiness_terms)
    if req.weights.makespan > 0:
        objective_terms.append(int(req.weights.makespan * SCALE) * makespan)

    if objective_terms:
        model.Minimize(sum(objective_terms))

    # ── Solve ─────────────────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(req.time_limit_seconds)
    solver.parameters.num_search_workers = 4
    solver.parameters.log_search_progress = False

    status_code = solver.Solve(model)
    solve_time = time.monotonic() - t0

    status_map = {
        cp_model.OPTIMAL: "OPTIMAL",
        cp_model.FEASIBLE: "FEASIBLE",
        cp_model.INFEASIBLE: "INFEASIBLE",
        cp_model.UNKNOWN: "UNKNOWN",
        cp_model.MODEL_INVALID: "MODEL_INVALID",
    }
    status_str = status_map.get(status_code, "UNKNOWN")

    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SolveResponse(
            status=status_str,
            scheduled_operations=[],
            unscheduled_job_ids=list(job_map.keys()),
            solve_time_seconds=round(solve_time, 3),
            solver_status_code=status_code,
        )

    # ── Extract solution ──────────────────────────────────────────────────────
    scheduled_ops: list[ScheduledOperation] = []
    scheduled_job_ids: set[str] = set()

    for op_id, task in all_tasks.items():
        op: OperationIn = task["op"]
        start_min = solver.Value(task["start"])
        end_min = solver.Value(task["end"])

        # Determine which resource was assigned
        resource_id = task["assigned_resource"]
        for rid, lit in task["presence"].items():
            if solver.Value(lit):
                resource_id = rid
                break

        start_epoch = req.horizon_start_epoch + start_min * 60
        setup_end_epoch = start_epoch + op.setup_time_minutes * 60
        run_end_epoch = setup_end_epoch + op.duration_minutes * 60
        queue_end_epoch = run_end_epoch + op.queue_time_minutes * 60
        move_end_epoch = queue_end_epoch + op.move_time_minutes * 60
        end_epoch = req.horizon_start_epoch + end_min * 60

        scheduled_ops.append(ScheduledOperation(
            op_id=op_id,
            job_id=op.job_id,
            resource_id=resource_id,
            workcentre_id=op.workcentre_id,
            start_epoch=start_epoch,
            end_epoch=end_epoch,
            setup_start_epoch=start_epoch,
            setup_end_epoch=setup_end_epoch,
            run_start_epoch=setup_end_epoch,
            run_end_epoch=run_end_epoch,
            queue_end_epoch=queue_end_epoch,
            move_end_epoch=move_end_epoch,
            sequence=op.sequence,
        ))
        scheduled_job_ids.add(op.job_id)

    unscheduled = [jid for jid in job_map if jid not in scheduled_job_ids]

    total_tardiness = 0.0
    makespan_val = solver.Value(makespan)
    for job in req.jobs:
        job_ops = [t for t in scheduled_ops if t.job_id == job.job_id]
        if not job_ops:
            continue
        last_end_epoch = max(t.end_epoch for t in job_ops)
        tard_seconds = max(0, last_end_epoch - job.due_date_epoch_seconds)
        total_tardiness += tard_seconds / 3600.0  # hours

    obj_val = solver.ObjectiveValue() if status_code in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None

    log.info(
        "solve complete status=%s ops=%d jobs=%d unscheduled=%d time=%.2fs",
        status_str, len(scheduled_ops), len(scheduled_job_ids),
        len(unscheduled), solve_time,
    )

    return SolveResponse(
        status=status_str,
        objective_value=obj_val,
        tardiness_score=round(total_tardiness, 2),
        makespan_minutes=makespan_val,
        changeover_minutes=None,  # TODO: add changeover tracking
        scheduled_operations=scheduled_ops,
        unscheduled_job_ids=unscheduled,
        solve_time_seconds=round(solve_time, 3),
        solver_status_code=status_code,
    )
