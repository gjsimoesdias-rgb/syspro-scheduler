/**
 * Server entry point.
 *
 * - Starts HTTP listener immediately so http://localhost:3000/ responds
 *   even when SQL Server is unreachable.
 * - Opens the two DB connections in the background and updates app.locals
 *   when ready (or stays null and routes return 503).
 * - Prints an aligned, ASCII-only banner at startup so terminals without
 *   wide-glyph support don't desync the box borders.
 */

import app from './app';
import { sysproConfig, schedulerConfig } from './config/database';
import environment from './config/environment';
import DatabaseConnection from './database/connection';
import AppStateStore from './services/AppStateStore';
import { AutoScheduler } from './services/autoScheduler';
import { generateHandler } from './api/routes/schedule';
import AuthService from './services/AuthService';
import MigrationRunner from './database/MigrationRunner';
import ensureSysproObjects from './database/ensureSysproObjects';
import path from 'path';

let sysproDb: DatabaseConnection;
let schedulerDb: DatabaseConnection;

/** Render a row of the startup banner with consistent inner width (54 chars). */
const BANNER_WIDTH = 54;
const bannerRow = (text: string): string => {
  const padded = text.padEnd(BANNER_WIDTH);
  return `  |${padded}|`;
};

function printStartupBanner(port: number): void {
  const top = `  +${'-'.repeat(BANNER_WIDTH)}+`;
  console.log('');
  console.log(top);
  console.log(bannerRow('  Syspro Scheduler is running'));
  console.log(bannerRow(''));
  console.log(bannerRow(`  >  Open the app:  http://localhost:${port}/`));
  console.log(bannerRow(`  >  API base:      http://localhost:${port}/api`));
  console.log(bannerRow(`  >  Health check:  http://localhost:${port}/health`));
  console.log(bannerRow(`  >  Readiness:     http://localhost:${port}/health/ready`));
  console.log(top);
  console.log('');
  console.log(`    env:                ${environment.nodeEnv}`);
  console.log(`    horizon:            ${environment.schedulingHorizonDays} days`);
  console.log(`    max overtime / day: ${environment.maxOvertimePerDay} hours`);
  console.log('');
}

async function startServer() {
  try {
    app.locals.connectionProfile = {
      server: process.env.SYSPRO_DB_SERVER || sysproConfig.server,
      database: process.env.SYSPRO_DB_NAME || sysproConfig.database,
      schedulerDatabase: process.env.SCHEDULER_DB_NAME || schedulerConfig.database,
      authMode: (process.env.SYSPRO_DB_AUTH_MODE || 'sql').toLowerCase(),
      userName: process.env.SYSPRO_DB_USER || '',
      instanceName: process.env.SYSPRO_DB_INSTANCE || sysproConfig.options?.instanceName || '',
      port: process.env.SYSPRO_DB_PORT ? Number(process.env.SYSPRO_DB_PORT) : null
    };

    const port = environment.port;
    const server = app.listen(port, () => {
      printStartupBanner(port);
    });

    // Background Auto plan — ticks every minute; does nothing until a planner
    // switches it on (Versions → Auto plan) and the databases are connected.
    const autoScheduler = new AutoScheduler(app, generateHandler);
    app.locals.autoScheduler = autoScheduler;
    if (process.env.NODE_ENV !== 'test') autoScheduler.start();

    // Connect to databases in the background (non-blocking)
    (async () => {
      try {
        sysproDb = new DatabaseConnection(sysproConfig as any);
        await sysproDb.connect();
        console.log('✓ Syspro database connected');
        app.locals.sysproDb = sysproDb;

        // Provision the scheduler-owned aps objects (aps.SavedSchedules,
        // aps.Scenarios) in this company's SYSPRO DB. Idempotent — safe on a
        // brand-new company. Non-fatal so a lack of DDL rights doesn't stop the
        // read-only side of the app.
        try {
          await ensureSysproObjects(sysproDb);
          console.log('✓ Syspro scheduler objects ensured');
        } catch (ensureErr: any) {
          console.error('✗ Could not ensure Syspro scheduler objects:', ensureErr.message);
        }
      } catch (dbError: any) {
        console.error('✗ Syspro database connection failed:', dbError.message);
        console.log('   Continuing without database (read-only mode)...');
        app.locals.sysproDb = null;
      }

      try {
        schedulerDb = new DatabaseConnection(schedulerConfig as any);
        await schedulerDb.connect();
        console.log('✓ Scheduler database connected');
        app.locals.schedulerDb = schedulerDb;

        // Wire up the durable backing store for things that used to live
        // only in app.locals (importedJobs, shifts, constraintOverrides...).
        // Hydrate the in-memory cache from sch_AppState so a server
        // restart no longer loses imported data.
        const appState = new AppStateStore(schedulerDb);
        app.locals.appState = appState;
        await appState.ensureTable();
        await appState.hydrateAppLocals(app.locals);

        // Run all pending DB migrations (idempotent — already-applied files
        // are skipped via the sch_Migrations tracking table).
        try {
          const migrationsDir = path.resolve(__dirname, 'database', 'migrations');
          const runner = new MigrationRunner(schedulerDb);
          await runner.run(migrationsDir);
          console.log('✓ Migrations checked');
        } catch (migErr: any) {
          console.warn('  Migration warning:', migErr.message);
        }

        // Seed default super admin if no users exist
        try {
          const authSvc = new AuthService(schedulerDb);
          await authSvc.seedDefaultAdmin();
        } catch (seedErr: any) {
          console.warn('  Seeding warning:', seedErr.message);
        }
      } catch (dbError: any) {
        console.error('✗ Scheduler database connection failed:', dbError.message);
        console.log('   Continuing without database (read-only mode)...');
        app.locals.schedulerDb = null;
        app.locals.appState = null;
      }
    })();

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      autoScheduler.stop();
      server.close(async () => {
        if (sysproDb) await sysproDb.disconnect();
        if (schedulerDb) await schedulerDb.disconnect();
        process.exit(0);
      });
    });

    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully...');
      server.close(async () => {
        if (sysproDb) await sysproDb.disconnect();
        if (schedulerDb) await schedulerDb.disconnect();
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
