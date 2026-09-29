# ADR 0003 — Custom migration runner instead of Umzug

**Date:** 2026-04-12  
**Status:** Accepted (supersede with Umzug at > 10 migrations — see roadmap #60)

## Context

The scheduler maintains a small set of SQL migrations that must run against the SCHEDULER database at startup. Options considered:

- **Umzug** — the standard Node.js migration framework used with Sequelize.
- **Flyway / Liquibase** — Java-based; heavyweight for a Node project.
- **Custom runner** — bespoke implementation.

## Decision

A custom `MigrationRunner` was implemented (`backend/src/database/MigrationRunner.ts`). It:

1. Creates `sch_Migrations(filename, appliedAt)` if it doesn't exist.
2. Reads `backend/src/database/migrations/*.sql` in alphabetical order.
3. Skips files already recorded in `sch_Migrations`.
4. Executes each unapplied file's batches (split on `GO`) inside a transaction.
5. Degrades gracefully — if the migrations table can't be created, the server boots in degraded mode rather than crashing.

## Consequences

**Positive**
- Zero extra dependencies.
- Handles `GO` batch separators natively (SSMS convention).
- Graceful degradation on DB unavailability at startup.
- Runs automatically on every `node dist/server.js` — no manual intervention.

**Negative**
- Does not support rollbacks (no `down` migrations).
- Less battle-tested than Umzug.
- If the migration file is edited after being applied, the runner won't detect the change.

## Migration plan

Switch to Umzug when the migration count exceeds 10. Umzug supports rollbacks, hooks, and a rich CLI. The tracking table schema can be migrated trivially.
