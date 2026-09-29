# ADR 0001 — CP-SAT solver runs as an out-of-process sidecar

**Date:** 2026-05-11
**Status:** Accepted
**Deciders:** Engineering team

---

## Context

The scheduler needs an optimisation engine capable of minimising tardiness,
makespan, and changeover simultaneously across all jobs and resources.
Google OR-Tools CP-SAT is the strongest open-source solver for this class of
problem, but it is a C++/Python library with no native Node.js binding.

Two integration strategies were considered:

1. **In-process via native addon (node-gyp / N-API)**: bundle OR-Tools as a
   compiled `.node` add-on so the solver runs inside the Express process.
2. **Out-of-process sidecar (HTTP microservice)**: run OR-Tools inside a
   dedicated Python FastAPI process; the Node backend calls it over localhost
   HTTP.

---

## Decision

We chose **option 2 — the out-of-process sidecar**.

The sidecar lives at `cp-sat/main.py` and exposes a single endpoint
`POST /solve`. The Node adapter is `CpSatSchedulingEngine.ts`, which
serialises a `SchedulingContext` to the sidecar's JSON contract, calls
`/solve`, and maps the response back to the standard `Schedule` shape.

---

## Rationale

| Criterion | In-process addon | Out-of-process sidecar |
|---|---|---|
| OR-Tools version control | Hard — tied to Node ABI | Easy — plain `pip install` |
| Build complexity | High (node-gyp, MSVC on Windows) | None on Node side |
| Crash isolation | A solver segfault kills Express | Solver crash is contained |
| Deployment | Single container | Two containers (or two processes) |
| Language boundary overhead | Zero | ~1–5 ms per request (LAN) |
| Developer onboarding | Requires C++ toolchain | Only Python 3.11 + pip |

The latency cost (~1–5 ms) is negligible next to typical solve times (5–60 s).
The operational benefits — isolated crash domain, independent scaling, easy
solver upgrades — outweigh it decisively.

---

## Consequences

**Positive**
- The Python process can be restarted independently without dropping the
  Express server or losing in-flight HTTP connections.
- OR-Tools upgrades are a one-line `pip install` change and a CI rebuild of
  the Python image only.
- The solver can be scaled out horizontally (multiple sidecar replicas behind
  a simple load balancer) without touching the Node codebase.

**Negative / mitigation required**
- The frontend `ScheduleSetupModal` must expose a **graceful degradation path**:
  if the sidecar is unreachable, `CpSatSchedulingEngine` returns an empty
  schedule with a `Critical` `ConstraintViolation` and the route falls back to
  the greedy engine automatically (see ADR 0002).
- `docker-compose.yml` must start both services and health-check the sidecar
  before marking the stack healthy.
- The JSON contract between Node and Python (`SolveRequest` / `SolveResponse`
  in `CpSatEngine.ts` and `cp-sat/main.py`) must be kept in sync manually.
  A shared OpenAPI or Pydantic schema would enforce this — tracked as a future
  improvement.

---

## Alternatives considered and rejected

**In-process addon** — rejected because the build toolchain complexity on
Windows (MSVC, Python 2 for node-gyp) is a significant on-boarding barrier,
and a solver crash would take down the entire scheduler process.

**WASM port of OR-Tools** — rejected because no production-quality WASM
port existed at the time of this decision, and the solver's performance
under WASM is substantially lower than native.
