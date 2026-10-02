/**
 * Auth secrets — the ONE place the JWT signing secret is read.
 *
 * Never falls back to a known string. If JWT_SECRET is missing, still the
 * .env.example placeholder, or shorter than 32 characters, a random secret
 * is generated and written back to backend/.env so sessions survive restarts.
 * If .env can't be written, the random secret is used for this process only
 * (everyone is signed out on the next restart) and a warning is logged.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MIN_LENGTH = 32;
const PLACEHOLDERS = new Set([
  'change_this_secret_in_production',
  'change_this_to_a_long_random_secret_in_production',
]);

export const isWeakSecret = (value: string | undefined): boolean =>
  !value || value.trim().length < MIN_LENGTH || PLACEHOLDERS.has(value.trim());

/**
 * A secret from backend/.env, or a freshly generated one written back to it
 * (so it survives restarts). Never falls back to a known value.
 */
function resolveSecret(name: string, isWeak: (v: string | undefined) => boolean, bytes: number, purpose: string): string {
  const current = process.env[name];
  if (!isWeak(current)) return current!.trim();

  const generated = crypto.randomBytes(bytes).toString('hex');
  if (process.env.NODE_ENV === 'test') {
    // Tests never touch backend/.env.
    process.env[name] = generated;
    return generated;
  }
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const nl = content.includes('\r\n') ? '\r\n' : '\n';
    const line = `${name}=${generated}`;
    const re = new RegExp(`^${name}=.*$`, 'm');
    const next = re.test(content)
      ? content.replace(re, line)
      : `${content.replace(/\s*$/, '')}${content ? nl : ''}${line}${nl}`;
    fs.writeFileSync(envPath, next, 'utf8');
    // eslint-disable-next-line no-console
    console.warn(`[security] ${name} was missing or weak — generated a new one and saved it to ${envPath}.`);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn(`[security] ${name} was missing or weak and ${envPath} could not be updated (${err?.message}). ` +
      `Using a random value for this run only — ${purpose}.`);
  }
  process.env[name] = generated;
  return generated;
}

const resolveJwtSecret = (): string =>
  resolveSecret('JWT_SECRET', isWeakSecret, 48, 'users will be signed out on restart');

export const JWT_SECRET: string = resolveJwtSecret();
export const JWT_EXPIRES_IN = '8h';

/**
 * Key for shop-floor wall screens (/shopfloor?key=…): read-only access to
 * today's operations without a user login. Rotate by deleting SHOPFLOOR_KEY
 * from backend/.env and restarting (old screen links stop working).
 */
export const SHOPFLOOR_KEY: string = resolveSecret(
  'SHOPFLOOR_KEY', (v) => !v || v.trim().length < 24, 24, 'shop-floor screens need a new link after a restart');
