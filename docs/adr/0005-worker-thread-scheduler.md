# ADR 0005 — Worker thread for schedule generation

**Date:** 2026-04-08  
**Status:** Accepted

## Context

Schedule generation for 100+ jobs can take 1–5 seconds. Running this on the Express main thread would block all other API requests during generation.

Options:
- **Worker thread** (`worker_threads`) — spawned per request, runs in the same process address space, communicates via `postMessage`.
- **Child process** (`child_process.fork`) — separate V8 instance; higher overhead per spawn.
- **Job queue** (Bull/BullMQ + Redis) — persistent queue, retries, monitoring; requires Redis dependency.
- **Async iteration** — break the schedule loop into microtasks via `setImmediate`.

## Decision

`worker_threads` per schedule-generation request (`scheduleWorker.ts`).

## Rationale

1. **No extra infrastructure** — no Redis, no queue daemon, no extra ports.
2. **Lower spawn cost** than `child_process.fork` — same process heap for static module cache.
3. **Sufficient isolation** — the scheduling algorithm is CPU-bound and pure; it doesn't need shared mutable state with the main thread.
4. **Termination** — if the worker hangs, the route can detect it via `worker.on('exit')` and return a 500.

## Consequences

**Positive**
- Main thread stays responsive during schedule generation.
- No external dependencies.

**Negative**
- Date objects must be manually re-hydrated from ISO strings after `postMessage` serialisation (see `scheduleWorker.ts` hydration block). Missing a field produces silent NaN.
- Concurrency is unbounded — 20 simultaneous generate requests spawn 20 workers. Rate limiting on `/api/schedule` (10 req/min) mitigates this in production.
- No persistent queue — if the server restarts mid-generation, the request is lost.
