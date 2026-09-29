/**
 * render-sql.mjs
 *
 * Renders *.sql.template files by substituting {{PLACEHOLDER}} tokens with
 * values from backend/.env (and the process environment).
 *
 * Usage:
 *   node scripts/render-sql.mjs
 *
 * The rendered files are written alongside each template (without the
 * .template suffix) and are gitignored — never commit them.
 *
 * Required env vars for sysprouser:
 *   SYSPRO_SQL_USER       Login name (e.g. sysprouser)
 *   SYSPRO_SQL_PASSWORD   Strong password
 *   SYSPRO_DB_NAME        Syspro database name (e.g. DUR_SysCompanyD)
 *   SCHEDULER_DB_NAME     Scheduler database name (e.g. SCHEDULER)
 *
 * Required env vars for db_user:
 *   SCHEDULER_SQL_USER    Login name
 *   SCHEDULER_SQL_PASSWORD Strong password
 *   SYSPRO_DB_NAME        Syspro database name
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

// Load backend/.env if present
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const envPath = join(rootDir, 'backend', '.env');

try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
  console.log(`Loaded env from ${envPath}`);
} catch {
  console.warn(`No backend/.env found at ${envPath} — using process environment only.`);
}

/**
 * Interpolate {{KEY}} tokens in text with values from process.env.
 * Throws if a referenced variable is not set.
 */
function interpolate(text, templatePath) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new Error(
        `Template ${templatePath}: variable {{${key}}} is not set. ` +
        `Add ${key} to backend/.env or your shell environment.`
      );
    }
    return value;
  });
}

/**
 * Find and render all *.sql.template files in a directory tree.
 */
function renderDirectory(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      renderDirectory(full);
    } else if (entry.endsWith('.sql.template')) {
      const outPath = full.slice(0, -'.template'.length); // strip .template
      try {
        const template = readFileSync(full, 'utf8');
        const rendered = interpolate(template, full);
        writeFileSync(outPath, rendered, 'utf8');
        console.log(`  ✓ ${basename(full)} → ${basename(outPath)}`);
      } catch (err) {
        console.error(`  ✗ ${basename(full)}: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

console.log('Rendering SQL templates...');
renderDirectory(rootDir);
console.log('Done.');
