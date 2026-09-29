#!/usr/bin/env node

const { execSync } = require('child_process');
const chalk = require('chalk');
const path = require('path');

// Accept instance name as first CLI arg, default to SQLEXPRESS04.
// Usage: node enableTCP.js [INSTANCE_NAME]
// e.g.:  node enableTCP.js SQLEXPRESS  or  node enableTCP.js MSSQLSERVER
const INSTANCE = process.argv[2] || process.env.SQL_INSTANCE || 'SQLEXPRESS04';

const log = {
  header: (msg) => console.log('\n' + chalk.cyan.bold(msg) + '\n'),
  success: (msg) => console.log(chalk.green('✓ ' + msg)),
  error: (msg) => console.log(chalk.red('✗ ' + msg)),
  info: (msg) => console.log(chalk.blue('ℹ ' + msg)),
  warn: (msg) => console.log(chalk.yellow('⚠ ' + msg)),
};

function run(cmd, silent = false) {
  try {
    const result = execSync(cmd, { encoding: 'utf-8', stdio: silent ? 'pipe' : 'inherit' });
    return { success: true, output: result };
  } catch (error) {
    return { success: false, output: error.message };
  }
}

function isAdmin() {
  try {
    execSync('net session', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findSQLVersion() {
  for (let version = 12; version <= 17; version++) {
    const regPath = `HKLM\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL${version}.${INSTANCE}`;
    try {
      execSync(`reg query "${regPath}" /v DisplayVersion`, { stdio: 'pipe' });
      return version;
    } catch {
      // Continue to next version
    }
  }
  return null;
}

function main() {
  console.clear();
  log.header('╔══════════════════════════════════════════════╗');
  log.header('║     SQL Server TCP/IP Configuration         ║');
  log.header('║         Syspro Scheduler Setup             ║');
  log.header('╚══════════════════════════════════════════════╝');

  // Step 1: Check Admin
  log.header('Step 1: Checking Administrator Privileges');
  if (!isAdmin()) {
    log.error('This app must be run as Administrator!');
    console.log('\nHow to fix:');
    console.log('  1. Find: C:\\Users\\Goncalo Dias\\SchedulerNEW_01042026\\TCPEnabler\\RUN.cmd');
    console.log('  2. Right-click → "Run as Administrator"\n');
    process.exit(1);
  }
  log.success('Running as Administrator');

  // Step 2: Find SQL Version
  log.header('Step 2: Finding SQL Server Version');
  log.info(`Target instance: ${INSTANCE} (override with: node enableTCP.js <INSTANCE_NAME>)`);
  const version = findSQLVersion();
  if (!version) {
    log.error(`Could not find SQL Server ${INSTANCE} installation!`);
    console.log('\nChecked versions: MSSQL12 through MSSQL17');
    console.log(`Tip: pass the instance name as an argument, e.g.: node enableTCP.js SQLEXPRESS`);
    console.log('Please verify SQL Server is installed.\n');
    process.exit(1);
  }
  log.success(`Found SQL Server: MSSQL${version}.${INSTANCE}`);

  // Step 3: Enable TCP/IP
  log.header('Step 3: Enabling TCP/IP in Registry');
  
  const tcpPath = `HKLM\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL${version}.${INSTANCE}\\MSSQLServer\\SuperSocketNetLib\\TCP`;
  
  let result = run(`reg add "${tcpPath}" /v "Enabled" /t REG_DWORD /d 1 /f`, true);
  if (result.success) {
    log.success('TCP/IP Enabled in registry');
  } else {
    log.error('Failed to enable TCP/IP: ' + result.output);
    process.exit(1);
  }

  // Step 4: Configure Port
  log.header('Step 4: Configuring Static Port 1433');
  
  const ipAllPath = `${tcpPath}\\IPAll`;
  
  result = run(`reg add "${ipAllPath}" /v "TcpPort" /t REG_DWORD /d 1433 /f`, true);
  if (result.success) {
    log.success('Port 1433 configured');
  } else {
    log.error('Failed to configure port: ' + result.output);
    process.exit(1);
  }

  // Step 5: Restart SQL Server
  log.header('Step 5: Restarting SQL Server Service');
  
  const svcName = `MSSQL$${INSTANCE}`;
  console.log(`Stopping service ${svcName}...`);
  run(`net stop "${svcName}"`, true);
  
  console.log('Waiting 2 seconds...');
  execSync('timeout /t 2 /nobreak', { stdio: 'inherit' });
  
  console.log(`Starting service ${svcName}...`);
  result = run(`net start "${svcName}"`, false);
  if (result.success || result.output.includes('successfully')) {
    log.success('SQL Server restarted');
  } else {
    log.warn('Service restart may have completed');
  }

  // Step 6: Verify Port
  log.header('Step 6: Verifying TCP Port');
  
  console.log('Waiting 3 seconds for service to stabilize...');
  execSync('timeout /t 3 /nobreak', { stdio: 'pipe' });
  
  result = run('netstat -ano | findstr ":1433"', true);
  if (result.success && result.output.includes('1433')) {
    log.success('Port 1433 is now LISTENING');
    console.log(chalk.dim(result.output.trim()));
  } else {
    log.warn('Port 1433 not detected immediately (may take a moment)');
  }

  // Success Message
  log.header('╔══════════════════════════════════════════════╗');
  log.header('║            Configuration Complete!          ║');
  log.header('╚══════════════════════════════════════════════╝');
  
  console.log(chalk.green('\n✓ TCP/IP is now ENABLED for SQL Server\n'));
  
  console.log('Next steps:');
  console.log(chalk.yellow('  1. Close this window'));
  console.log(chalk.yellow('  2. Run: START_ALL.cmd\n'));
  
  console.log('Backend should now connect successfully with:');
  console.log(chalk.cyan('  ✓ Syspro database connected'));
  console.log(chalk.cyan('  ✓ Scheduler database connected\n'));
}

main();
