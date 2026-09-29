-- Migration 007: Line-group support
-- lineGroupId is stored as a JSON property within the sch_AppState 'resourceDefinitions' key.
-- No DDL change is required; this migration is intentionally a no-op.
SELECT 1 AS migration_007_ok;
