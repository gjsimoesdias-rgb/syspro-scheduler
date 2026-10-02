/**
 * Which licensed company (dbo.lic_companies) a request plans for.
 *
 * Company users carry their company in the token. super_admin, Windows (NTLM)
 * users and the background Auto plan don't — they used to get the built-in
 * default rules, so the same plan came out differently depending on who
 * pressed Generate. They now get the company of the connected SYSPRO
 * database:
 *   1. the user's own companyId, when set
 *   2. the lic_companies row whose syspro_company_id matches the connected
 *      SYSPRO company DB name (case-insensitive)
 *   3. the only company, when exactly one exists (the usual single-site install)
 *   otherwise null → built-in defaults.
 */
import type { Request } from 'express';
import { companyDbOf } from '../services/planStore';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; id: number | null }>();

/** Pure decision (exported for tests). */
export function pickCompany(
  rows: Array<{ id: number; syspro_company_id?: string | null }>,
  companyDb: string
): number | null {
  const db = companyDb.trim().toLowerCase();
  const match = rows.find((r) => String(r.syspro_company_id ?? '').trim().toLowerCase() === db && db !== '');
  if (match) return Number(match.id);
  return rows.length === 1 ? Number(rows[0].id) : null;
}

/** Company of the connected SYSPRO database (cached for a minute). */
export async function connectedCompanyId(app: { locals: Record<string, any> }): Promise<number | null> {
  const schedulerDb = app.locals.schedulerDb;
  if (!schedulerDb) return null;
  const companyDb = companyDbOf(app.locals.sysproDb);
  const hit = cache.get(companyDb);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  try {
    const r = await schedulerDb.query(`SELECT id, syspro_company_id FROM dbo.lic_companies`);
    const id = pickCompany(r.recordset || [], companyDb);
    cache.set(companyDb, { at: Date.now(), id });
    return id;
  } catch {
    return null;
  }
}

/** The company whose settings apply to this request. */
export async function companyFor(req: Request): Promise<number | null> {
  const own = (req as any).user?.companyId;
  if (own) return Number(own);
  return connectedCompanyId(req.app);
}

/** Test hook. */
export const __resetCompanyCache = () => cache.clear();
