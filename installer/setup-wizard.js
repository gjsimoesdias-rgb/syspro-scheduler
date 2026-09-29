#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');
const envExamplePath = path.join(backendDir, '.env.example');
const envPath = path.join(backendDir, '.env');

const flags = new Set(process.argv.slice(2));
const useDefaults = flags.has('--defaults');
const skipTest = flags.has('--skip-test');
const dryRun = flags.has('--dry-run');

const parseEnvFile = (text = '') => {
  return text.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return acc;
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();
    const value = rawValue.replace(/^"|"$/g, '');
    acc[key] = value;
    return acc;
  }, {});
};

const formatEnvValue = (value) => {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /[\s#"']/g.test(text) ? JSON.stringify(text) : text;
};

const buildEnvFile = (config) => {
  const orderedKeys = [
    'NODE_ENV',
    'PORT',
    'LOG_LEVEL',
    'SYSPRO_DB_SERVER',
    'SYSPRO_DB_INSTANCE',
    'SYSPRO_DB_PORT',
    'SYSPRO_DB_NAME',
    'SYSPRO_DB_AUTH_MODE',
    'SYSPRO_DB_DOMAIN',
    'SYSPRO_DB_USER',
    'SYSPRO_DB_PASSWORD',
    'SYSPRO_DB_ENCRYPT',
    'SCHEDULER_DB_SERVER',
    'SCHEDULER_DB_INSTANCE',
    'SCHEDULER_DB_PORT',
    'SCHEDULER_DB_NAME',
    'SCHEDULER_DB_AUTH_MODE',
    'SCHEDULER_DB_DOMAIN',
    'SCHEDULER_DB_USER',
    'SCHEDULER_DB_PASSWORD',
    'SCHEDULER_DB_ENCRYPT',
    'HORIZON_DAYS',
    'SCHEDULE_INTERVAL',
    'MAX_OVERTIME_HOURS',
    'BATCH_MIN_SIZE',
    'SETUP_TIME_MIN',
    'QUEUE_TIME_MIN',
    'MOVEMENT_TIME_MIN'
  ];

  return orderedKeys
    .map((key) => `${key}=${formatEnvValue(config[key] ?? '')}`)
    .join('\n') + '\n';
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = async (label, currentValue) => {
  if (useDefaults) return currentValue;
  return new Promise((resolve) => {
    rl.question(`${label} [${currentValue ?? ''}]: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || currentValue || '');
    });
  });
};

const buildSqlConfig = (prefix, config) => {
  const authMode = String(config[`${prefix}_AUTH_MODE`] || 'sql').toLowerCase();
  const instanceName = String(config[`${prefix}_INSTANCE`] || '').trim();
  const port = Number(config[`${prefix}_PORT`] || 0) || undefined;

  const connection = {
    server: String(config[`${prefix}_SERVER`] || 'localhost').trim() || 'localhost',
    database: String(config[`${prefix}_NAME`] || 'master').trim() || 'master',
    options: {
      encrypt: String(config[`${prefix}_ENCRYPT`] || 'false').toLowerCase() === 'true',
      trustServerCertificate: true,
      connectTimeout: 15000
    }
  };

  if (port) {
    connection.port = port;
  } else if (instanceName && authMode !== 'windows') {
    connection.options.instanceName = instanceName;
  }

  if (authMode === 'windows') {
    connection.options.trustedConnection = true;
  } else {
    connection.authentication = {
      type: 'default',
      options: {
        userName: String(config[`${prefix}_USER`] || '').trim(),
        password: String(config[`${prefix}_PASSWORD`] || '')
      }
    };
  }

  return connection;
};

const testConnection = async (label, prefix, config) => {
  try {
    const sql = require(path.join(backendDir, 'node_modules', 'mssql'));
    const connection = buildSqlConfig(prefix, config);
    const pool = await sql.connect(connection);
    const result = await pool.request().query('SELECT DB_NAME() AS dbName');
    await pool.close();
    console.log(`✓ ${label} connection successful (${result.recordset?.[0]?.dbName || connection.database})`);
    return true;
  } catch (error) {
    console.log(`⚠ ${label} connection failed: ${error.message}`);
    return false;
  }
};

async function main() {
  console.log('========================================');
  console.log('   Syspro Scheduler Setup Wizard');
  console.log('========================================\n');

  const template = fs.existsSync(envExamplePath)
    ? parseEnvFile(fs.readFileSync(envExamplePath, 'utf8'))
    : {};
  const existing = fs.existsSync(envPath)
    ? parseEnvFile(fs.readFileSync(envPath, 'utf8'))
    : {};

  const config = {
    NODE_ENV: 'production',
    PORT: '3000',
    LOG_LEVEL: 'info',
    SYSPRO_DB_SERVER: os.hostname(),
    SYSPRO_DB_INSTANCE: 'SQLEXPRESS',
    SYSPRO_DB_PORT: '',
    SYSPRO_DB_NAME: 'SYSPRO',
    SYSPRO_DB_AUTH_MODE: 'windows',
    SYSPRO_DB_DOMAIN: '',
    SYSPRO_DB_USER: '',
    SYSPRO_DB_PASSWORD: '',
    SYSPRO_DB_ENCRYPT: 'false',
    SCHEDULER_DB_SERVER: os.hostname(),
    SCHEDULER_DB_INSTANCE: 'SQLEXPRESS',
    SCHEDULER_DB_PORT: '',
    SCHEDULER_DB_NAME: 'SCHEDULER',
    SCHEDULER_DB_AUTH_MODE: 'windows',
    SCHEDULER_DB_DOMAIN: '',
    SCHEDULER_DB_USER: '',
    SCHEDULER_DB_PASSWORD: '',
    SCHEDULER_DB_ENCRYPT: 'false',
    HORIZON_DAYS: '28',
    SCHEDULE_INTERVAL: '3600000',
    MAX_OVERTIME_HOURS: '3.0',
    BATCH_MIN_SIZE: '1',
    SETUP_TIME_MIN: '30',
    QUEUE_TIME_MIN: '15',
    MOVEMENT_TIME_MIN: '10',
    ...template,
    ...existing
  };

  console.log('Enter the SYSPRO SQL Server settings. Press Enter to keep the default shown.\n');

  config.SYSPRO_DB_SERVER = await ask('SYSPRO SQL Server host', config.SYSPRO_DB_SERVER);
  config.SYSPRO_DB_INSTANCE = await ask('SYSPRO SQL instance', config.SYSPRO_DB_INSTANCE);
  config.SYSPRO_DB_PORT = await ask('SYSPRO SQL port (optional)', config.SYSPRO_DB_PORT);
  config.SYSPRO_DB_NAME = await ask('SYSPRO database name', config.SYSPRO_DB_NAME);
  config.SYSPRO_DB_AUTH_MODE = (await ask('Authentication mode (windows/sql)', config.SYSPRO_DB_AUTH_MODE)).toLowerCase() === 'windows' ? 'windows' : 'sql';

  if (config.SYSPRO_DB_AUTH_MODE === 'sql') {
    config.SYSPRO_DB_USER = await ask('SQL user name', config.SYSPRO_DB_USER);
    config.SYSPRO_DB_PASSWORD = await ask('SQL password', config.SYSPRO_DB_PASSWORD);
  }

  config.SCHEDULER_DB_SERVER = await ask('Scheduler SQL Server host', config.SCHEDULER_DB_SERVER || config.SYSPRO_DB_SERVER);
  config.SCHEDULER_DB_INSTANCE = await ask('Scheduler SQL instance', config.SCHEDULER_DB_INSTANCE || config.SYSPRO_DB_INSTANCE);
  config.SCHEDULER_DB_PORT = await ask('Scheduler SQL port (optional)', config.SCHEDULER_DB_PORT || config.SYSPRO_DB_PORT);
  config.SCHEDULER_DB_NAME = await ask('Scheduler database name', config.SCHEDULER_DB_NAME);
  config.SCHEDULER_DB_AUTH_MODE = (await ask('Scheduler auth mode (windows/sql)', config.SCHEDULER_DB_AUTH_MODE || config.SYSPRO_DB_AUTH_MODE)).toLowerCase() === 'windows' ? 'windows' : 'sql';

  if (config.SCHEDULER_DB_AUTH_MODE === 'sql') {
    config.SCHEDULER_DB_USER = await ask('Scheduler SQL user name', config.SCHEDULER_DB_USER || config.SYSPRO_DB_USER);
    config.SCHEDULER_DB_PASSWORD = await ask('Scheduler SQL password', config.SCHEDULER_DB_PASSWORD || config.SYSPRO_DB_PASSWORD);
  }

  // Never ship the .env.example placeholder as the JWT signing secret.
  const jwt = String(config.JWT_SECRET || '');
  if (jwt.length < 32 || /change_this/i.test(jwt)) {
    config.JWT_SECRET = require('crypto').randomBytes(48).toString('hex');
  }

  const envOutput = buildEnvFile(config);

  if (!skipTest) {
    console.log('\nTesting database connections...');
    await testConnection('SYSPRO', 'SYSPRO_DB', config);
    await testConnection('Scheduler', 'SCHEDULER_DB', config);
  }

  if (dryRun) {
    console.log('\nDry run complete. No file was written.');
  } else {
    fs.writeFileSync(envPath, envOutput, 'utf8');
    console.log(`\n✓ Configuration saved to ${envPath}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Build the software: npm run build:software');
  console.log('  2. Start the software: npm run start:software');
  console.log('  3. Open http://localhost:3000');
}

main()
  .catch((error) => {
    console.error(`\nSetup failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
