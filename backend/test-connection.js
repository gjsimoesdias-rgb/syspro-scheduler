/**
 * test-connection.js
 *
 * Standalone smoke test for the SYSPRO and SCHEDULER database connections.
 * Reads credentials from backend/.env (does NOT depend on the rest of the
 * server), opens a connection to each DB, runs `SELECT 1`, and prints a
 * pass/fail line for each.
 *
 * Usage (from the backend folder):
 *
 *     node test-connection.js
 *
 * Exit code is 0 if both connections succeed, 1 otherwise — handy for CI
 * or a pre-flight check.
 */

require('dotenv').config();
const sql = require('mssql');

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function buildConfig(prefix) {
  const authMode = (process.env[`${prefix}_DB_AUTH_MODE`] || 'sql').toLowerCase();
  const server = process.env[`${prefix}_DB_SERVER`];
  const database = process.env[`${prefix}_DB_NAME`];
  const portRaw = process.env[`${prefix}_DB_PORT`];
  const instance = process.env[`${prefix}_DB_INSTANCE`];

  if (!server) throw new Error(`${prefix}_DB_SERVER is not set in .env`);
  if (!database) throw new Error(`${prefix}_DB_NAME is not set in .env`);

  const config = {
    server,
    database,
    options: {
      encrypt: process.env[`${prefix}_DB_ENCRYPT`] === 'true',
      trustServerCertificate: true,
      connectTimeout: 10000,
    },
  };

  if (authMode === 'sql') {
    const userName = process.env[`${prefix}_DB_USER`];
    const password = process.env[`${prefix}_DB_PASSWORD`];
    if (!userName) throw new Error(`${prefix}_DB_USER is required when AUTH_MODE=sql`);
    if (!password) throw new Error(`${prefix}_DB_PASSWORD is required when AUTH_MODE=sql`);
    config.authentication = {
      type: 'default',
      options: { userName, password },
    };
  } else {
    config.options.trustedConnection = true;
  }

  if (portRaw) {
    config.port = parseInt(portRaw, 10);
  } else if (instance) {
    config.options.instanceName = instance;
  }

  return { config, authMode, server, database, port: portRaw, instance };
}

async function testOne(label, prefix) {
  console.log(`${COLORS.cyan}▸ ${label} (${prefix})${COLORS.reset}`);
  let info;
  try {
    info = buildConfig(prefix);
  } catch (e) {
    console.log(`  ${COLORS.red}✗ Config error:${COLORS.reset} ${e.message}\n`);
    return false;
  }

  console.log(
    `  ${COLORS.dim}server=${info.server}` +
      (info.port ? ` port=${info.port}` : info.instance ? ` instance=${info.instance}` : '') +
      ` db=${info.database} auth=${info.authMode}${COLORS.reset}`
  );

  const pool = new sql.ConnectionPool(info.config);
  const start = Date.now();
  try {
    await pool.connect();
    const result = await pool.request().query('SELECT 1 AS ok, @@VERSION AS version');
    const took = Date.now() - start;
    const version = (result.recordset[0].version || '').split('\n')[0].trim();
    console.log(`  ${COLORS.green}✓ Connected${COLORS.reset} in ${took}ms`);
    console.log(`  ${COLORS.dim}${version}${COLORS.reset}\n`);
    await pool.close();
    return true;
  } catch (err) {
    const took = Date.now() - start;
    console.log(`  ${COLORS.red}✗ Connection failed${COLORS.reset} after ${took}ms`);
    console.log(`    code:    ${err.code || '(none)'}`);
    console.log(`    message: ${err.message}`);
    if (err.originalError && err.originalError.message && err.originalError.message !== err.message) {
      console.log(`    cause:   ${err.originalError.message}`);
    }
    if (err.code === 'ELOGIN') {
      console.log(`    ${COLORS.yellow}hint: username/password rejected by SQL Server${COLORS.reset}`);
    } else if (err.code === 'ESOCKET' || err.code === 'ETIMEOUT') {
      console.log(`    ${COLORS.yellow}hint: SQL Server unreachable. Check TCP/IP is enabled,${COLORS.reset}`);
      console.log(`    ${COLORS.yellow}      SQL Browser is running, port matches, firewall allows it.${COLORS.reset}`);
    } else if (err.code === 'EDBCREDS') {
      console.log(`    ${COLORS.yellow}hint: missing or malformed credentials${COLORS.reset}`);
    }
    console.log('');
    try { await pool.close(); } catch (_) { /* ignore */ }
    return false;
  }
}

(async () => {
  console.log(`${COLORS.cyan}=== DB connection smoke test ===${COLORS.reset}\n`);
  const sysproOk = await testOne('SYSPRO database', 'SYSPRO');
  const schedulerOk = await testOne('SCHEDULER database', 'SCHEDULER');

  if (sysproOk && schedulerOk) {
    console.log(`${COLORS.green}✓ Both databases connected successfully.${COLORS.reset}`);
    process.exit(0);
  } else {
    console.log(
      `${COLORS.red}✗ ${[!sysproOk && 'SYSPRO', !schedulerOk && 'SCHEDULER']
        .filter(Boolean)
        .join(' + ')} failed. See details above.${COLORS.reset}`
    );
    process.exit(1);
  }
})();
