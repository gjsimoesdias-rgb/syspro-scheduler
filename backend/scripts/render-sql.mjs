#!/usr/bin/env node
/**
 * Renders *.sql.template files into runnable *.sql files by substituting
 * {{VARIABLE_NAME}} placeholders with values from the current environment
 * (loaded from .env via dotenv).
 *
 * Usage: node scripts/render-sql.mjs [template1.sql.template ...]
 *
 * If no templates are specified, all *.sql.template files in the repo root
 * and backend/ are rendered.
 *
 * The rendered .sql files are NOT committed (they appear in .gitignore).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from backend/
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const templates = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => resolve(f))
  : [
      resolve(__dirname, '../create_sysprouser.sql.template'),
      resolve(__dirname, '../../create_db_user.sql.template'),
    ];

for (const tpl of templates) {
  if (!existsSync(tpl)) {
    console.warn(`Template not found: ${tpl}`);
    continue;
  }

  let content = readFileSync(tpl, 'utf-8');

  // Replace all {{VAR_NAME}} with process.env.VAR_NAME
  content = content.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    const val = process.env[name];
    if (!val) {
      console.warn(`  Warning: environment variable ${name} is not set`);
      return `<${name}_NOT_SET>`;
    }
    return val;
  });

  const out = tpl.replace(/\.template$/, '');
  writeFileSync(out, content, 'utf-8');
  console.log(`  Rendered: ${out}`);
}

console.log('Done. Add the rendered .sql files to .gitignore if not already present.');
