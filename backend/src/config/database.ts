import dotenv from 'dotenv';

dotenv.config();

type DbAuthMode = 'sql' | 'windows';

const getAuthMode = (value: string | undefined): DbAuthMode => {
  return value?.toLowerCase() === 'windows' ? 'windows' : 'sql';
};

/**
 * Read a required env var. Throws fast at process start if it's missing —
 * this is intentional. We never want to silently fall back to a default
 * credential like 'sa' / 'password' (CWE-798).
 */
const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env or your process environment before starting the server. ` +
        `Default credentials are no longer supported.`
    );
  }
  return value;
};

const sysproAuthMode = getAuthMode(process.env.SYSPRO_DB_AUTH_MODE);
const schedulerAuthMode = getAuthMode(process.env.SCHEDULER_DB_AUTH_MODE);

const sysproPort = process.env.SYSPRO_DB_PORT ? parseInt(process.env.SYSPRO_DB_PORT, 10) : undefined;
const schedulerPort = process.env.SCHEDULER_DB_PORT ? parseInt(process.env.SCHEDULER_DB_PORT, 10) : undefined;

// Server names: required for SQL auth, but Windows auth uses local ODBC DSN which can omit them.
const sysproServer =
  sysproAuthMode === 'windows'
    ? (process.env.SYSPRO_DB_SERVER || 'localhost')
    : requireEnv('SYSPRO_DB_SERVER');

const sysproInstance = process.env.SYSPRO_DB_INSTANCE;

const schedulerServer =
  schedulerAuthMode === 'windows'
    ? (process.env.SCHEDULER_DB_SERVER || 'localhost')
    : requireEnv('SCHEDULER_DB_SERVER');

const schedulerInstance = process.env.SCHEDULER_DB_INSTANCE;

// Database names: always required — there is no sensible default.
const sysproDbName = requireEnv('SYSPRO_DB_NAME');
const schedulerDbName = requireEnv('SCHEDULER_DB_NAME');

// ── Syspro DB ────────────────────────────────────────────────────────────────
const sysproServerFull = sysproInstance ? `${sysproServer}\\${sysproInstance}` : sysproServer;

const sysproConfig: any = sysproAuthMode === 'windows'
  ? {
      // mssql/msnodesqlv8: supply full connection string for Windows auth via ODBC Driver 17
      connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=${sysproServerFull};Database=${sysproDbName};Trusted_Connection=yes;TrustServerCertificate=yes;`,
      driver: 'msnodesqlv8'
    }
  : {
      server: sysproServer,
      database: sysproDbName,
      options: {
        encrypt: process.env.SYSPRO_DB_ENCRYPT === 'true',
        trustServerCertificate: true,
        connectTimeout: 30000,
        ...(sysproInstance ? { instanceName: sysproInstance } : {})
      },
      authentication: {
        type: 'default',
        options: {
          userName: requireEnv('SYSPRO_DB_USER'),
          password: requireEnv('SYSPRO_DB_PASSWORD')
        }
      }
    };

if (sysproAuthMode !== 'windows' && sysproPort) sysproConfig.port = sysproPort;

// ── Scheduler DB ─────────────────────────────────────────────────────────────
const schedulerServerFull = schedulerInstance ? `${schedulerServer}\\${schedulerInstance}` : schedulerServer;

const schedulerConfig: any = schedulerAuthMode === 'windows'
  ? {
      connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=${schedulerServerFull};Database=${schedulerDbName};Trusted_Connection=yes;TrustServerCertificate=yes;`,
      driver: 'msnodesqlv8'
    }
  : {
      server: schedulerServer,
      database: schedulerDbName,
      options: {
        encrypt: process.env.SCHEDULER_DB_ENCRYPT === 'true',
        trustServerCertificate: true,
        connectTimeout: 30000,
        ...(schedulerInstance ? { instanceName: schedulerInstance } : {})
      },
      authentication: {
        type: 'default',
        options: {
          userName: requireEnv('SCHEDULER_DB_USER'),
          password: requireEnv('SCHEDULER_DB_PASSWORD')
        }
      }
    };

if (schedulerAuthMode !== 'windows' && schedulerPort) schedulerConfig.port = schedulerPort;

export { sysproConfig, schedulerConfig, sysproAuthMode, schedulerAuthMode };
