/**
 * ensureSysproObjects — idempotently create the scheduler-owned objects the app
 * writes into the SYSPRO company database (the `aps` schema).
 *
 * Since the §6.7 move, the scheduler's own persistence (plan versions, publish
 * status) lives in the SCHEDULER DB — see services/planStore.ts. Only the aps
 * schema itself is ensured here. The LYNQ compatibility mirror objects
 * (aps.SourceProductionOrders, views, procs, …) are provisioned separately by
 * create_aps_lynq_compat_objects.sql.
 *
 * Every statement is guarded (IF NOT EXISTS / OBJECT_ID IS NULL) so this is safe
 * to run on every connect, including against a brand-new company DB. Failures
 * are thrown to the caller, which logs and continues in degraded mode.
 */
import type DatabaseConnection from './connection';
import { logger } from '../utils/logger';

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    // Only the schema for the LYNQ compatibility objects / export staging.
    // Plan versions and publish status moved to the SCHEDULER DB
    // (services/planStore.ts); legacy aps.SavedSchedules / aps.JobPublishStatus /
    // aps.Scenarios are left untouched where they exist and copied across once.
    label: "schema 'aps'",
    sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'aps')
            EXEC('CREATE SCHEMA aps');`,
  },
];

/**
 * Ensure the scheduler-owned aps objects exist in the connected SYSPRO database.
 * Runs each guarded DDL statement in its own batch. Throws on the first failure.
 */
export async function ensureSysproObjects(db: DatabaseConnection): Promise<void> {
  for (const { label, sql } of STATEMENTS) {
    try {
      await db.query(sql);
    } catch (err: any) {
      logger.error({ err, object: label }, `ensureSysproObjects: failed to ensure ${label}`);
      throw err;
    }
  }
  logger.info({ count: STATEMENTS.length }, 'ensureSysproObjects: scheduler-owned aps objects ensured');
}

export default ensureSysproObjects;
