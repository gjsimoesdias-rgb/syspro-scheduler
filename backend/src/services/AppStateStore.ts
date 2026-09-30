/**
 * AppStateStore — durable backing for everything that used to live in
 * `app.locals` and got wiped on restart.
 *
 * Design choices:
 *  - One JSON-blob table (sch_AppState) keyed by name. Cheap to read,
 *    cheap to write, no schema churn while UI shapes are still settling.
 *  - The in-memory cache stays — every read in route handlers still hits
 *    `app.locals.X` directly so the hot path is sync. Writes go to memory
 *    AND through here.
 *  - All writes are best-effort with try/catch + warn — losing one
 *    persistence write must NOT break the running server.
 *
 * Once the UI shapes are stable, peel keys out into typed tables.
 */

import DatabaseConnection from '../database/connection';
import { logger } from '../utils/logger';

export type AppStateKey =
  | 'importedJobs'
  | 'importedOperations'
  | 'resourceDefinitions'
  | 'shiftTemplates'
  | 'constraintOverrides'
  | 'alternativeGroups'
  | 'pinnedOperations'
  | 'calendarExceptions';

export class AppStateStore {
  constructor(private db: DatabaseConnection) {}

  /**
   * Create the table if missing. Safe to call on every boot.
   * Mirrors backend/src/database/migrations/001_app_state.sql.
   */
  async ensureTable(): Promise<void> {
    try {
      await this.db.query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = N'sch_AppState')
        BEGIN
          CREATE TABLE sch_AppState (
            stateKey   NVARCHAR(100) NOT NULL PRIMARY KEY,
            payload    NVARCHAR(MAX) NOT NULL,
            updatedAt  DATETIME2     NOT NULL CONSTRAINT DF_sch_AppState_updatedAt DEFAULT SYSUTCDATETIME(),
            updatedBy  NVARCHAR(100) NULL
          );
        END
      `);
      logger.info('sch_AppState table verified');
    } catch (err: any) {
      logger.warn({ err }, 'Could not ensure sch_AppState table — persistence disabled for this run');
    }
  }

  /** Return the parsed payload, or undefined if the row is missing or malformed. */
  async get<T = unknown>(key: AppStateKey): Promise<T | undefined> {
    try {
      const result = await this.db.queryWithParams(
        `SELECT payload FROM sch_AppState WHERE stateKey = @key`,
        { key }
      );
      const row = result.recordset?.[0];
      if (!row?.payload) return undefined;
      return JSON.parse(row.payload) as T;
    } catch (err: any) {
      logger.warn({ err, key }, 'AppStateStore.get failed');
      return undefined;
    }
  }

  /** Upsert the payload. Best-effort — never throws. */
  async set<T = unknown>(key: AppStateKey, value: T, updatedBy = 'system'): Promise<void> {
    try {
      const payload = JSON.stringify(value ?? null);
      await this.db.queryWithParams(
        `
        MERGE sch_AppState WITH (HOLDLOCK) AS target
        USING (SELECT @key AS stateKey, @payload AS payload, @updatedBy AS updatedBy) AS src
          ON target.stateKey = src.stateKey
        WHEN MATCHED THEN UPDATE SET
          payload = src.payload,
          updatedAt = SYSUTCDATETIME(),
          updatedBy = src.updatedBy
        WHEN NOT MATCHED THEN
          INSERT (stateKey, payload, updatedBy)
          VALUES (src.stateKey, src.payload, src.updatedBy);
        `,
        { key, payload, updatedBy }
      );
    } catch (err: any) {
      logger.warn({ err, key }, 'AppStateStore.set failed (state retained in memory only)');
    }
  }

  /** Delete a row. Used by tests and admin endpoints; not required during normal use. */
  async clear(key: AppStateKey): Promise<void> {
    try {
      await this.db.queryWithParams(`DELETE FROM sch_AppState WHERE stateKey = @key`, { key });
    } catch (err: any) {
      logger.warn({ err, key }, 'AppStateStore.clear failed');
    }
  }

  /**
   * Hydrate the live in-memory `app.locals` cache from the persisted store.
   * Called once at server startup, after the SCHEDULER DB connects.
   */
  async hydrateAppLocals(appLocals: Record<string, any>): Promise<void> {
    const keys: AppStateKey[] = [
      'importedJobs',
      'importedOperations',
      'resourceDefinitions',
      'shiftTemplates',
      'constraintOverrides',
      'alternativeGroups',
      'pinnedOperations',
      'calendarExceptions',
    ];
    let restored = 0;
    for (const key of keys) {
      const value = await this.get(key);
      if (value !== undefined) {
        appLocals[key] = value;
        restored++;
      }
    }
    if (restored > 0) {
      logger.info({ restored }, `AppStateStore hydrated ${restored} keys from sch_AppState`);
    }
  }
}

export default AppStateStore;
