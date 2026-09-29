# ADR 0002 — No ORM; use parameterised raw SQL via mssql

**Date:** 2026-04-01  
**Status:** Accepted

## Context

The scheduler needs to query SYSPRO's existing SQL Server schema, which was not designed for ORM consumption (mixed naming conventions, schema variants across SYSPRO versions, three-level fallback chains using `OBJECT_ID()` and `COL_LENGTH()` guards).

ORMs evaluated: Prisma, TypeORM, Sequelize, Knex.

## Decision

Direct parameterised SQL via the `mssql` + `msnodesqlv8` drivers.

## Consequences

**Positive**
- Full control over exact SQL emitted — critical for schema-variant fallbacks.
- No migration-generation problem: SYSPRO tables are not owned by this app.
- Parameterisation is enforced at the driver level (`mssql`'s `request.input()` API / the `queryWithParams` wrapper), not by convention.
- `withTransaction` helper encapsulates `BEGIN TRAN` / `COMMIT` / `ROLLBACK` cleanly.

**Negative**
- SQL queries are strings — no compile-time type-safety on column names.
- Schema changes in SYSPRO require manual query updates.
- Testing requires either a live DB or a mock for `DatabaseConnection`.

## Notes

All queries touching user-controlled input MUST use parameterised form. No string concatenation of external values into SQL strings is permitted. This is enforced at code review.
