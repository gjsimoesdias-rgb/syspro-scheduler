#!/usr/bin/env node
/**
 * Cross-platform migration copy script.
 * Replaces the Windows-only `xcopy /E /I /Y` in the build script so CI on
 * Linux / macOS works without modification.
 */
import { cpSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = resolve(__dirname, '../src/database/migrations');
const dest = resolve(__dirname, '../dist/database/migrations');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied migrations: ${src} → ${dest}`);
