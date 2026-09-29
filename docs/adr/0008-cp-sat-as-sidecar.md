# ADR 0008 — CP-SAT Solver Deployed as a Python Sidecar Process

**Date:** 2026-05  
**Status:** Accepted

## Context

ADR 0007 introduced the `ISchedulingEngine` interface so the optimisation
back-end could be swapped at request time. The greedy engine (ADR 0004) is
fast but cannot prove optimality; customers with complex line-balance
requirements asked for a constraint-programming alternative.

Google OR-Tools CP-SAT is the leading open-source CP solver. It is written
in C++ and distributed as a Python package (`ortools`). The Node.js
ecosystem has no mature CP-SAT binding, leaving three implementation paths:

| Option | Trade-offs |
|---|---|
| **WASM port** | Experimental; 60-70 MB download; limited solver feature set. |
| **Child process + IPC** | Spawns Python per request; cold-start ~2 s; no persistent state. |
| **Persistent sidecar (HTTP)** | One Python process stays warm; <50 ms IPC overhead; can be containerised separately. |

The persistent sidecar was chosen.

## Decision

Run a FastAPI/Uvicorn Python service (`cp-sat/main.py`) on `localhost:8080`
(configurable via `CP_SAT_URL` env var). The Node.js `CpSatEngine` sends a
JSON `SolveRequest` over HTTP and receives a `SolveResponse`.

```
SchedulingEngine (Node) ──POST /solve──► cp-sat/main.py (Python)
   CpSatEngine.solve()                    OR-Tools CP-SAT solver
        │                                         │
        └─── JSON SolveResponse ◄─────────────────┘
```

**Request/response contract** is defined in `backend/src/services/CpSatEngine.ts`
(TypeScript) and mirrored in `cp-sat/main.py` (Python dataclasses). Any
change to the schema must be reflected in both.

## Consequences

**Positive**
- CP-SAT can prove optimality for small–medium horizons (≤ 500 variables).
- Solver is kept warm; median solve latency for 100 jobs is < 3 s.
- Python and Node processes can be scaled independently.
- The Node service never imports C++ native modules, keeping the Docker image small.

**Negative / risks**
- Two runtimes to maintain (Node.js + Python 3.12).
- Health-check gap: if the sidecar crashes, the Node app returns 503 from
  the `CpSatEngine` path but the `GreedyEngine` path still works — planners
  must be told which engine failed.
- The HTTP round-trip adds ~5-50 ms vs. in-process; acceptable given solve
  times are in the seconds range.
- `CP_SAT_TIMEOUT_MS` must be tuned per deployment (default 30 000 ms).

## Mitigations

- `/health/ready` in the backend pings the sidecar and returns `cpSatReady:
  false` if it is unreachable, so the frontend can disable the CP-SAT toggle.
- `CpSatEngine` falls back to a `GreedyEngine` result when the sidecar returns
  a non-2xx response, logging a warning with the trace ID.
- The sidecar is containerised alongside the backend in `docker-compose.yml`
  with a `depends_on` + `healthcheck`.

## Alternatives considered

- **Node.js bindings to OR-Tools** (`node-ortools`): last updated 2022,
  incompatible with Node 20+. Rejected.
- **Child process per request**: cold-start makes interactive re-schedules
  feel sluggish. Rejected.
- **Commercial solver (CPLEX, Gurobi)**: licence cost and WASM/Node support
  unclear. Deferred to future evaluation.
