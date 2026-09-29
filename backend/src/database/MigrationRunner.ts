/**
 * MigrationRunner — applies pending SQL migration files via Umzug.
 *
 * Umzug handles migration tracking (applied filenames are stored in the
 * `sch_Migrations` table via MssqlStorage).  SQL files use `GO` as a batch
 * separator (SSMS convention); each batch is executed in its own query call.
 *
 * If any migration fails the server continues in degraded mode rather than
 * crashing so existing data is never left in a partially-migrated state.
 */

import fs from 'fs';
import path from 'path';
import { Umzug } from 'umzug';
import type { UmzugStorage, MigrationParams } from 'umzug';
import DatabaseConnection from '../database/connection';
import { logger } from '../utils/logger';

// ── Custom MSSQL storage backend for Umzug ───────────────────────────────────

class MssqlStorage implements UmzugStorage<unknown> {
  constructor(private db: DatabaseConnection) {}

  async logMigration({ name }: MigrationParams<unknown>): Promise<void> {
    await this.db.queryWithParams(
      `INSERT INTO sch_Migrations (filename) VALUES (@filename)`,
      { filename: name },
    );
  }

  async unlogMigration({ name }: MigrationParams<unknown>): Promise<void> {
    await this.db.queryWithParams(
      `DELETE FROM sch_Migrations WHERE filename = @filename`,
      { filename: name },
    );
  }

  async executed(_meta: Pick<MigrationParams<unknown>, 'context'>): Promise<string[]> {
    const result = await this.db.query(
      `SELECT filename FROM sch_Migrations ORDER BY filename`,
    );
    const rows: Array<{ filename: string }> = result.recordset ?? [];
    return rows.map((r) => r.filename);
  }
}

// ── MigrationRunner ───────────────────────────────────────────────────────────

export class MigrationRunner {
  constructor(private db: DatabaseConnection) {}

  /** Create the tracking table if it does not yet exist. */
  private async ensureTable(): Promise<void> {
    await this.db.query(`
      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = N'sch_Migrations')
      BEGIN
        CREATE TABLE sch_Migrations (
          filename  NVARCHAR(260) NOT NULL PRIMARY KEY,
          appliedAt DATETIME2     NOT NULL CONSTRAINT DF_sch_Migrations_appliedAt DEFAULT SYSUTCDATETIME()
        );
      END
    `);
  }

  /**
   * Run all unapplied migrations from the given directory.
   * @param migrationsDir Absolute path to the directory that contains *.sql files.
   */
  async run(migrationsDir: string): Promise<void> {
    try {
      await this.ensureTable();
    } catch (err: any) {
      logger.warn({ err }, 'MigrationRunner: could not ensure sch_Migrations table — skipping migrations');
      return;
    }

    const db = this.db;
    const storage = new MssqlStorage(db);

    const umzug = new Umzug({
      migrations: {
        glob: path.join(migrationsDir, '*.sql').replace(/\\/g, '/'),
        resolve({ name, path: filePath }) {
          return {
            name,
            up: async () => {
              if (!filePath) throw new Error(`No path for migration ${name}`);
              const sql = fs.readFileSync(filePath, 'utf8');
              // Split on GO batch separators (SSMS convention). Ignore blank batches.
              const batches = sql
                .split(/\bGO\b/gi)
                .map((b) => b.trim())
                .filter(Boolean);
              logger.info({ name, batches: batches.length }, 'Running migration');
              for (const batch of batches) {
                await db.query(batch);
              }
            },
            // SQL files do not have an automatic rollback; down is a no-op.
            down: async () => {},
          };
        },
      },
      storage,
      logger: console,
    });

    const pending = await umzug.pending();
    if (pending.length === 0) {
      logger.debug('MigrationRunner: no pending migrations');
      return;
    }
    logger.info({ count: pending.length }, 'MigrationRunner: applying pending migrations');

    try {
      const executed = await umzug.up();
      logger.info({ applied: executed.map((m) => m.name) }, 'MigrationRunner: all migrations applied');
    } catch (err: any) {
      logger.error({ err }, 'MigrationRunner: migration failed — server will continue in degraded mode');
    }
  }
}

export default MigrationRunner;
